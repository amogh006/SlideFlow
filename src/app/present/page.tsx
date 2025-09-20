'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { useAppContext } from '@/context/AppContext';
import {
  Carousel,
  CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';
import { Button } from '@/components/ui/button';
import { Expand, Hand, Mic, Pause, Play, RefreshCw, Shrink, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';

interface DebugInfo {
  status: string;
  currentSlide: number;
  audioPlayerState: 'idle' | 'playing' | 'paused' | 'buffering' | 'stopped';
  isMainAudioPlaying: boolean;
  isQaAudioPlaying: boolean;
  currentCaption: string;
}

// Helper to decode Base64
const decodeBase64 = (base64: string) => {
  if (typeof window === 'undefined') return new ArrayBuffer(0);
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

export default function PresentPage() {
  const { isAuthenticated, slides, presentationScript } = useAppContext();
  const router = useRouter();
  const { toast } = useToast();

  const [isFullScreen, setIsFullScreen] = useState(false);
  const carouselContainerRef = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<CarouselApi>();
  const [currentSlideIndex, setCurrentSlideIndex] = useState(-1);

  const ws = useRef<WebSocket | null>(null);
  
  // Audio state
  const audioContext = useRef<AudioContext>();
  const mainAudioQueue = useRef<AudioBuffer[]>([]);
  const currentMainAudioSource = useRef<AudioBufferSourceNode | null>(null);
  const qaAudioSource = useRef<AudioBufferSourceNode | null>(null);

  // Interrupt (Q&A) state
  const [isInterruptOpen, setInterruptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const recognition = useRef<any>(null);

  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    status: 'Disconnected',
    currentSlide: 0,
    audioPlayerState: 'idle',
    isMainAudioPlaying: false,
    isQaAudioPlaying: false,
    currentCaption: '',
  });

  useEffect(() => {
    if (!isAuthenticated || slides.length === 0 || !presentationScript) {
      router.push('/upload');
    }
  }, [isAuthenticated, slides, presentationScript, router]);
  
   useEffect(() => {
    if (typeof window !== 'undefined') {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return () => {
        audioContext.current?.close();
    }
  }, []);

  const updateDebug = (newInfo: Partial<DebugInfo>) => {
    setDebugInfo((prev) => ({ ...prev, ...newInfo }));
  };
  
  const stopMainAudio = () => {
    if (currentMainAudioSource.current) {
        currentMainAudioSource.current.onended = null; // Prevent onended from triggering next chunk
        currentMainAudioSource.current.stop();
        currentMainAudioSource.current = null;
    }
    mainAudioQueue.current = [];
    updateDebug({ audioPlayerState: 'stopped', isMainAudioPlaying: false });
  }

  const playMainAudio = async () => {
    if (mainAudioQueue.current.length === 0) {
      updateDebug({ isMainAudioPlaying: false, audioPlayerState: 'idle' });
      return;
    }
    if (!audioContext.current || audioContext.current.state === 'closed') {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    await audioContext.current.resume();

    const buffer = mainAudioQueue.current.shift();
    if (!buffer) return;

    const source = audioContext.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.current.destination);
    source.onended = () => {
        if (currentMainAudioSource.current === source) {
            playMainAudio(); // Play next chunk
        }
    };
    source.start();
    currentMainAudioSource.current = source;
    updateDebug({ audioPlayerState: 'playing', isMainAudioPlaying: true });
  }
  
  const stopQA = () => {
    if (qaAudioSource.current) {
        qaAudioSource.current.stop();
        qaAudioSource.current = null;
    }
    updateDebug({ isQaAudioPlaying: false });
  }

  const playQAAudio = async (buffer: ArrayBuffer) => {
    stopMainAudio(); // Ensure main audio is stopped
    stopQA(); // Stop any previous Q&A audio

    if (!audioContext.current || audioContext.current.state === 'closed') {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    await audioContext.current.resume();
    const audioBuffer = await audioContext.current.decodeAudioData(buffer);

    const source = audioContext.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.current.destination);
    source.onended = () => {
        updateDebug({ isQaAudioPlaying: false });
    };
    source.start();
    qaAudioSource.current = source;
    updateDebug({ isQaAudioPlaying: true });
  }


  useEffect(() => {
    if (!presentationScript || ws.current) return;

    const newWs = new WebSocket('ws://147.93.102.137:8000/ws/presentation');
    ws.current = newWs;
    updateDebug({ status: 'Connecting...' });

    newWs.onopen = () => {
      console.log('WebSocket connected');
      updateDebug({ status: 'Connected' });
      newWs.send(
        JSON.stringify({
          type: 'load_presentation',
          data: presentationScript,
        })
      );
    };

    newWs.onmessage = async (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'connected':
          updateDebug({ status: 'Connected (Server ACK)' });
          break;
        case 'presentation_loaded':
          updateDebug({ status: 'Presentation Loaded' });
           if (currentSlideIndex !== -1 && ws.current?.readyState === WebSocket.OPEN) {
             ws.current.send(
              JSON.stringify({ type: 'slide_start', slide_number: currentSlideIndex + 1 })
            );
          }
          break;
        case 'audio_chunk':
            if (!audioContext.current) break;
            try {
                const audioData = decodeBase64(message.audio_data);
                const audioBuffer = await audioContext.current.decodeAudioData(audioData);
                mainAudioQueue.current.push(audioBuffer);
                if (!debugInfo.isMainAudioPlaying) {
                   playMainAudio();
                }
            } catch (e) {
                console.error("Error decoding audio chunk", e);
            }
          break;
        case 'slide_started':
          stopMainAudio();
          const slideScript = presentationScript?.slides[message.slide_number - 1];
          if (slideScript) {
            updateDebug({
              currentCaption: slideScript.script,
            });
          }
          break;
        case 'slide_done':
          console.log(`Slide ${message.slide_number} audio stream finished from server.`);
          break;
        case 'qa_response':
           const qaCaption = `Q: ${message.question}\nA: ${message.answer}`;
           updateDebug({ currentCaption: qaCaption });
           try {
            const qaAudioData = decodeBase64(message.audio_data);
            playQAAudio(qaAudioData);
           } catch(e) {
            console.error("Error handling Q&A audio", e);
           }
          break;
        case 'error':
          console.error(`WebSocket Error: ${message.message}`);
          updateDebug({ status: `Error: ${message.message}` });
           if(message.message === 'Cannot interrupt when state is idle.') {
              setInterruptOpen(false);
          }
          toast({
            title: 'Presentation Error',
            description: message.message,
            variant: 'destructive',
          });
          break;
      }
    };

    newWs.onclose = () => {
      console.log('WebSocket disconnected');
      updateDebug({ status: 'Disconnected' });
      stopMainAudio();
      stopQA();
    };

    newWs.onerror = (error) => {
      console.error('WebSocket error:', error);
      updateDebug({ status: 'Error' });
    };

    return () => {
      newWs?.close();
      ws.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationScript, toast]);

  useEffect(() => {
    if (!api) {
      return;
    }

    const handleSelect = () => {
      const newSlideIndex = api.selectedScrollSnap();
      if (newSlideIndex === currentSlideIndex) return;
      
      setCurrentSlideIndex(newSlideIndex);
      
      stopMainAudio();
      updateDebug({
        currentSlide: newSlideIndex + 1,
        currentCaption: 'Loading slide...',
      });

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(
          JSON.stringify({ type: 'slide_start', slide_number: newSlideIndex + 1 })
        );
      }
    };
    
    api.on('select', handleSelect);
    
    // Set initial slide index
    if(currentSlideIndex === -1) {
      setCurrentSlideIndex(0);
    }
    
    return () => {
      api.off('select', handleSelect);
    };
  }, [api, currentSlideIndex]);


  const handleFullScreenChange = () => {
    if (typeof document !== 'undefined') {
      setIsFullScreen(!!document.fullscreenElement);
    }
  };

  const toggleFullScreen = () => {
    const element = carouselContainerRef.current;
    if (!element) return;

    if (typeof document !== 'undefined') {
      if (!document.fullscreenElement) {
        element.requestFullscreen().catch((err) => {
          console.error(
            `Error attempting to enable full-screen mode: ${err.message} (${err.name})`
          );
        });
      } else {
        document.exitFullscreen();
      }
    }
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f') toggleFullScreen();
      if (e.key === 'Escape' && document.fullscreenElement)
        document.exitFullscreen();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullScreenChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // --- Interrupt and Speech Recognition Logic ---

  const handleInterrupt = () => {
    if (!debugInfo.isMainAudioPlaying) {
      toast({
        title: "Cannot Interrupt",
        description: "Interrupt is only available when presentation audio is playing.",
        variant: "destructive",
      });
      return;
    }
    stopMainAudio();
    ws.current?.send(JSON.stringify({ type: 'stop' })); // Tell backend to stop sending audio
    setTranscribedText('');
    setInterruptOpen(true);
  };

  const askQuestion = () => {
    stopQA();
    if (ws.current && ws.current.readyState === WebSocket.OPEN && transcribedText) {
      ws.current.send(
        JSON.stringify({ type: 'interrupt', question: transcribedText })
      );
      updateDebug({ currentCaption: `Asking: "${transcribedText}"` });
    }
  };
  
  const closeInterrupt = () => {
    stopRecording();
    stopQA();
    setInterruptOpen(false);
  };

  const startRecording = () => {
    if (recognition.current) {
      try {
        recognition.current.start();
        setIsRecording(true);
      } catch (e) {
        console.error("Speech recognition start error", e);
        toast({ title: "Mic Error", description: "Could not start microphone.", variant: "destructive"});
      }
    }
  };

  const stopRecording = () => {
    if (recognition.current) {
      recognition.current.stop();
      setIsRecording(false);
    }
  };
  
  useEffect(() => {
    // Initialize speech recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognition.current = new SpeechRecognition();
      recognition.current.continuous = true;
      recognition.current.interimResults = true;
      recognition.current.lang = 'en-US';

      recognition.current.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        setTranscribedText(finalTranscript + interimTranscript);
      };

      recognition.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        toast({ title: "Speech Recognition Error", description: event.error, variant: "destructive"});
        setIsRecording(false);
      };
      
      recognition.current.onend = () => {
        setIsRecording(false);
      };

    } else {
      console.warn('Speech Recognition not supported in this browser.');
    }
  }, [toast]);


  if (!isAuthenticated || slides.length === 0) {
    return null; // Or a loading/redirecting message
  }

  const replayCurrentSlide = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN && currentSlideIndex !== -1) {
        stopMainAudio();
        stopQA();
        ws.current.send(
            JSON.stringify({ type: 'slide_start', slide_number: currentSlideIndex + 1 })
        );
    }
  }


  return (
    <div
      ref={carouselContainerRef}
      className="bg-gray-900 text-white w-full h-screen flex flex-col items-center justify-center relative group"
    >
      <div className="absolute top-4 left-4 z-20 bg-black/50 p-2 rounded-lg text-xs w-80">
        <h3 className="font-bold text-base mb-2">Debugger</h3>
        <table className="w-full text-left">
          <tbody>
            <tr>
              <td className="pr-2 opacity-70">WS Status:</td>
              <td className="font-mono">{debugInfo.status}</td>
            </tr>
            <tr>
              <td className="pr-2 opacity-70">Slide:</td>
              <td className="font-mono">
                {debugInfo.currentSlide} / {slides.length}
              </td>
            </tr>
            <tr>
              <td className="pr-2 opacity-70">Main Audio:</td>
              <td className="font-mono">{debugInfo.isMainAudioPlaying ? 'Playing' : 'Stopped'}</td>
            </tr>
             <tr>
              <td className="pr-2 opacity-70">Q&A Audio:</td>
              <td className="font-mono">{debugInfo.isQaAudioPlaying ? 'Playing' : 'Stopped'}</td>
            </tr>
            <tr>
              <td className="pr-2 opacity-70 align-top">Caption:</td>
              <td className="font-mono h-20 overflow-y-auto block">
                {debugInfo.currentCaption}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Carousel setApi={setApi} className="w-full h-full" opts={{ loop: false }}>
        <CarouselContent className="h-full">
          {slides.map((slideUrl, index) => (
            <CarouselItem key={index} className="h-full">
              <div className="w-full h-full p-12 flex items-center justify-center">
                <Image
                  src={slideUrl}
                  alt={`Slide ${index + 1}`}
                  width={1920}
                  height={1080}
                  className="w-auto h-auto max-w-full max-h-full object-contain"
                />
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="absolute left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 hover:bg-black/75 border-none text-white h-12 w-12" />
        <CarouselNext className="absolute right-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 hover:bg-black/75 border-none text-white h-12 w-12" />
      </Carousel>
      
      <div className="absolute bottom-6 left-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
         <Button
          variant="ghost"
          size="icon"
          onClick={replayCurrentSlide}
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className="h-5 w-5" />
          <span className="sr-only">Replay Slide</span>
        </Button>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
        <p className="text-center text-xl whitespace-pre-wrap h-20 overflow-y-auto">
          {debugInfo.currentCaption}
        </p>
      </div>

       <Dialog open={isInterruptOpen} onOpenChange={setInterruptOpen}>
        <DialogContent className="sm:max-w-[425px] bg-gray-800 border-gray-700 text-white">
          <DialogHeader>
            <DialogTitle>Ask a Question</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <p className="text-sm text-gray-400">
                {isRecording ? "Listening..." : "Press the mic to ask your question."}
            </p>
            <div className="p-4 border border-gray-600 rounded-md min-h-[80px] bg-gray-900">
                {transcribedText}
            </div>
            <div className="flex justify-center">
                 <Button
                    variant={isRecording ? "destructive" : "default"}
                    size="icon"
                    onClick={isRecording ? stopRecording : startRecording}
                    className="rounded-full w-16 h-16"
                    >
                    <Mic className="h-8 w-8" />
                </Button>
            </div>
          </div>
          <DialogFooter>
             <Button onClick={askQuestion} disabled={!transcribedText || isRecording}>Ask</Button>
             <DialogClose asChild>
                <Button variant="outline" onClick={closeInterrupt}>Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleInterrupt}
          disabled={!debugInfo.isMainAudioPlaying}
          className="text-yellow-400 hover:bg-white/10 hover:text-yellow-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Hand className="h-5 w-5" />
          <span className="sr-only">Ask a question</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleFullScreen}
          className="text-white hover:bg-white/10 hover:text-white"
        >
          {isFullScreen ? (
            <Shrink className="h-5 w-5" />
          ) : (
            <Expand className="h-5 w-5" />
          )}
          <span className="sr-only">Toggle Fullscreen</span>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <Link href="/upload">
            <X className="h-5 w-5" />
            <span className="sr-only">Exit Presentation</span>
          </Link>
        </Button>
      </div>
    </div>
  );
}

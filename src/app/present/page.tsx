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
import { Expand, Hand, Mic, Shrink, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
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
  totalChunks: number;
  chunksReceived: number;
  audioPlayerState: 'idle' | 'playing' | 'buffering' | 'paused' | 'loaded';
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
  const audioChunks = useRef<ArrayBuffer[]>([]);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] = useState(0);

  // Interrupt (Q&A) state
  const [isInterruptOpen, setInterruptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const recognition = useRef<any>(null); // Using `any` for SpeechRecognition
  const qaAudioElement = useRef<HTMLAudioElement | null>(null);
  const [qaAudioSrc, setQaAudioSrc] = useState<string | null>(null);


  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    status: 'Disconnected',
    currentSlide: 0,
    totalChunks: 0,
    chunksReceived: 0,
    audioPlayerState: 'idle',
    currentCaption: '',
  });

  useEffect(() => {
    if (!isAuthenticated || slides.length === 0 || !presentationScript) {
      router.push('/upload');
    }
  }, [isAuthenticated, slides, presentationScript, router]);

  const updateDebug = (newInfo: Partial<DebugInfo>) => {
    setDebugInfo((prev) => ({ ...prev, ...newInfo }));
  };
  
  const stopMainAudio = () => {
    if (audioElement.current) {
        audioElement.current.pause();
        audioElement.current.currentTime = 0;
    }
    if (audioSrc) {
        URL.revokeObjectURL(audioSrc);
        setAudioSrc(null);
    }
    audioChunks.current = [];
    setAudioProgress(0);
    updateDebug({ audioPlayerState: 'idle' });
  };
  
  // Effect to handle audio source changes
  useEffect(() => {
    if (audioSrc && audioElement.current) {
        audioElement.current.src = audioSrc;
        audioElement.current.play().catch(e => console.error("Audio play failed:", e));
        updateDebug({audioPlayerState: 'playing'});
    }
  }, [audioSrc]);
  
  // Effect for Q&A audio
  useEffect(() => {
    if (qaAudioSrc && qaAudioElement.current) {
      qaAudioElement.current.src = qaAudioSrc;
      qaAudioElement.current.play().catch(e => console.error("QA Audio play failed:", e));
    }
  }, [qaAudioSrc]);


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
          const audioData = decodeBase64(message.audio_data);
          audioChunks.current.push(audioData);
          updateDebug({
              chunksReceived: (prev) => prev + 1,
              audioPlayerState: 'buffering'
          });
          const progress = debugInfo.totalChunks > 0 ? (audioChunks.current.length / debugInfo.totalChunks) * 100 : 0;
          setAudioProgress(progress);
          break;
        case 'slide_started':
          stopMainAudio();
          const slideScript = presentationScript?.slides[message.slide_number - 1];
          if (slideScript) {
            updateDebug({
              currentCaption: slideScript.script,
              totalChunks: slideScript.script_chunks?.length || 0,
              chunksReceived: 0,
            });
          }
          setAudioProgress(0);
          break;
        case 'slide_done':
          console.log(`Slide ${message.slide_number} audio stream finished from server.`);
          if (audioChunks.current.length > 0) {
            const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
            const url = URL.createObjectURL(blob);
            setAudioSrc(url);
            updateDebug({audioPlayerState: 'loaded'});
          }
          break;
        case 'qa_response':
           const qaCaption = `Q: ${message.question}\nA: ${message.answer}`;
           updateDebug({ currentCaption: qaCaption });
           try {
            const qaAudioData = decodeBase64(message.audio_data);
            const blob = new Blob([qaAudioData], { type: 'audio/webm' });
            const url = URL.createObjectURL(blob);
            setQaAudioSrc(url);
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
    };

    newWs.onerror = (error) => {
      console.error('WebSocket error:', error);
      updateDebug({ status: 'Error' });
    };

    return () => {
      newWs?.close();
      ws.current = null;
      stopMainAudio();
      stopQA();
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


  // Effect to handle slide changes (including initial load)
  useEffect(() => {
    if (currentSlideIndex === -1) return;

    stopMainAudio();
    updateDebug({
      currentSlide: currentSlideIndex + 1,
      currentCaption: 'Loading slide...',
      chunksReceived: 0,
      totalChunks: 0,
    });

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(
        JSON.stringify({ type: 'slide_start', slide_number: currentSlideIndex + 1 })
      );
    }
  }, [currentSlideIndex]);


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
    if (audioElement.current && !audioElement.current.paused) {
        audioElement.current.pause();
        updateDebug({audioPlayerState: 'paused'});
    }
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
    if(audioElement.current && audioElement.current.paused) {
        audioElement.current.play();
        updateDebug({audioPlayerState: 'playing'});
    }
  };
  
  const stopQA = () => {
    if (qaAudioElement.current) {
        qaAudioElement.current.pause();
        qaAudioElement.current.currentTime = 0;
    }
    if (qaAudioSrc) {
        URL.revokeObjectURL(qaAudioSrc);
        setQaAudioSrc(null);
    }
  }

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

  const updateAudioTime = () => {
     if (audioElement.current) {
      const { currentTime, duration } = audioElement.current;
      if (duration > 0) {
        setAudioProgress((currentTime / duration) * 100);
      }
    }
  }


  return (
    <div
      ref={carouselContainerRef}
      className="bg-gray-900 text-white w-full h-screen flex flex-col items-center justify-center relative group"
    >
      <audio ref={audioElement} onTimeUpdate={updateAudioTime} onEnded={() => updateDebug({ audioPlayerState: 'loaded' })} />
      <audio ref={qaAudioElement} />

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
              <td className="pr-2 opacity-70">Audio State:</td>
              <td className="font-mono">{debugInfo.audioPlayerState}</td>
            </tr>
            <tr>
              <td className="pr-2 opacity-70">Chunks:</td>
              <td className="font-mono">
                {debugInfo.chunksReceived} / {debugInfo.totalChunks}
              </td>
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

      <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-center text-xl whitespace-pre-wrap h-20 overflow-y-auto">
          {debugInfo.currentCaption}
        </p>
      </div>

      <div className="absolute bottom-0 left-0 right-0 w-full h-1 group-hover:h-2 transition-all">
        <Progress
          value={audioProgress}
          className="w-full h-full bg-gray-500/50 [&>div]:bg-red-600 rounded-none"
        />
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
          className="text-yellow-400 hover:bg-white/10 hover:text-yellow-300"
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

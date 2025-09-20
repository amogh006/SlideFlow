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
  lastChunkSize: number;
  audioPlayerState: 'idle' | 'playing' | 'buffering' | 'paused';
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

  const ws = useRef<WebSocket | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const audioQueue = useRef<AudioBuffer[]>([]);
  const isPlaying = useRef(false);
  const sourceNode = useRef<AudioBufferSourceNode | null>(null);
  const resumeState = useRef<{ buffer: AudioBuffer; isQA: boolean } | null>(
    null
  );

  const [currentSlideIndex, setCurrentSlideIndex] = useState(-1);

  const [audioProgress, setAudioProgress] = useState(0);
  const totalAudioDuration = useRef(0);
  const playbackStartTime = useRef(0);
  const pausedTime = useRef(0);
  const progressInterval = useRef<NodeJS.Timeout | null>(null);

  // Interrupt (Q&A) state
  const [isInterruptOpen, setInterruptOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const recognition = useRef<any>(null); // Using `any` for SpeechRecognition
  const qaAudioQueue = useRef<AudioBuffer[]>([]);
  const isPlayingQA = useRef(false);
  const qaSourceNode = useRef<AudioBufferSourceNode | null>(null);

  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    status: 'Disconnected',
    currentSlide: 0,
    totalChunks: 0,
    chunksReceived: 0,
    lastChunkSize: 0,
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

  const stopAudio = (isPausing = false) => {
    if (progressInterval.current) {
      clearInterval(progressInterval.current);
      progressInterval.current = null;
    }

    if (sourceNode.current) {
      if (isPausing && audioContext.current) {
        pausedTime.current = audioContext.current.currentTime - playbackStartTime.current;
        
        // Don't modify the source buffer directly. Instead, just save the pause time.
        // We'll use this to calculate the offset when resuming.
        const remainingDuration = totalAudioDuration.current - pausedTime.current;

        if(remainingDuration > 0) {
            // We have something to resume. The buffer itself is still in sourceNode.current.buffer
            resumeState.current = { buffer: sourceNode.current.buffer, isQA: false };
            updateDebug({ audioPlayerState: 'paused' });
        } else {
            resumeState.current = null;
        }

      } else {
        resumeState.current = null;
      }

      sourceNode.current.onended = null;
      try {
        sourceNode.current.stop();
      } catch (e) {
        console.warn('Audio stop error:', e);
      }
      sourceNode.current = null;
    }

    isPlaying.current = false;

    if (!isPausing) {
      audioQueue.current = [];
      setAudioProgress(0);
      totalAudioDuration.current = 0;
      playbackStartTime.current = 0;
      pausedTime.current = 0;
      resumeState.current = null;
      updateDebug({ audioPlayerState: 'idle' });
    }
  };

  const playNextAudioChunk = async (isQA = false) => {
    if (isPlaying.current || audioQueue.current.length === 0) {
      return;
    }

    if (!audioContext.current || audioContext.current.state === 'closed') {
      try {
        audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        console.error('Web Audio API is not supported', e);
        return;
      }
    }
    await audioContext.current.resume();

    const concatenatedBuffer = await concatenateAudioBuffers(audioQueue.current);
    audioQueue.current = []; // Clear queue
    if (!concatenatedBuffer) return;

    isPlaying.current = true;
    updateDebug({ audioPlayerState: 'playing' });
    totalAudioDuration.current = concatenatedBuffer.duration;
    
    const source = audioContext.current.createBufferSource();
    source.buffer = concatenatedBuffer;
    source.connect(audioContext.current!.destination);

    source.onended = () => {
      isPlaying.current = false;
      sourceNode.current = null;
      updateDebug({ audioPlayerState: 'idle' });
      // When narration finishes, we don't automatically do anything.
      // We wait for the user to go to the next slide.
    };

    source.start(0, 0);
    sourceNode.current = source;
    playbackStartTime.current = audioContext.current.currentTime;
    pausedTime.current = 0;

    if (progressInterval.current) clearInterval(progressInterval.current);
    progressInterval.current = setInterval(() => {
      if (audioContext.current && isPlaying.current) {
        const elapsedTime = audioContext.current.currentTime - playbackStartTime.current;
        const progress = (elapsedTime / totalAudioDuration.current) * 100;
        setAudioProgress(Math.min(progress, 100));
      }
    }, 100);
  };

  const resumeMainAudio = async () => {
      if (!resumeState.current || !audioContext.current) return;

      const { buffer } = resumeState.current;
      const offset = pausedTime.current;
      resumeState.current = null; // Clear resume state

      if (offset >= buffer.duration) {
          updateDebug({ audioPlayerState: 'idle' });
          return; // Nothing to resume
      }
      
      isPlaying.current = true;
      updateDebug({ audioPlayerState: 'playing' });

      const source = audioContext.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.current.destination);

      source.onended = () => {
          isPlaying.current = false;
          sourceNode.current = null;
          updateDebug({ audioPlayerState: 'idle' });
      };

      source.start(0, offset); // Start from the paused offset
      sourceNode.current = source;

      // Adjust playback start time to account for the pause
      playbackStartTime.current = audioContext.current.currentTime - offset;
  };


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
          console.log(message.message);
          updateDebug({ status: 'Connected (Server ACK)' });
          break;
        case 'presentation_loaded':
          console.log(message.message);
          updateDebug({ status: 'Presentation Loaded' });
          if (api && currentSlideIndex !== -1) {
             newWs.send(JSON.stringify({ type: 'slide_start', slide_number: currentSlideIndex + 1 }));
          }
          break;
        case 'audio_chunk':
          try {
            const audioData = decodeBase64(message.audio_data);
            updateDebug({
              chunksReceived: (prev) => prev + 1,
              lastChunkSize: audioData.byteLength,
            });
            if (
              audioContext.current ||
              (typeof window !== 'undefined' &&
                (window.AudioContext || (window as any).webkitAudioContext))
            ) {
              if (!audioContext.current || audioContext.current.state === 'closed') {
                audioContext.current = new (window.AudioContext ||
                  (window as any).webkitAudioContext)();
              }
              const audioBuffer =
                await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              updateDebug({ audioPlayerState: 'buffering' });
              
              if (!isPlaying.current && audioQueue.current.length === 1) {
                  playNextAudioChunk();
              }
            }
          } catch (e) {
            console.error('Error decoding audio data:', e);
          }
          break;
        case 'slide_started':
          stopAudio();
          const slideScript = presentationScript.slides[message.slide_number - 1];
          updateDebug({
            currentCaption: slideScript.script,
            totalChunks: slideScript.script_chunks.length,
            chunksReceived: 0,
          });
          setAudioProgress(0);
          totalAudioDuration.current = 0;
          pausedTime.current = 0;
          playbackStartTime.current = 0;
          break;
        case 'slide_done':
          console.log(`Slide ${message.slide_number} audio stream finished from server.`);
          if (!isPlaying.current && audioQueue.current.length > 0) {
            playNextAudioChunk();
          }
          break;
        case 'qa_response':
          const qaCaption = `Q: ${message.question}\nA: ${message.answer}`;
          updateDebug({ currentCaption: qaCaption });
          // Don't stop main audio, just play QA
          try {
            const audioData = decodeBase64(message.audio_data);
            updateDebug({ lastChunkSize: audioData.byteLength, chunksReceived: 1, totalChunks: 1 });
            if (audioContext.current) {
                const audioBuffer = await audioContext.current.decodeAudioData(audioData);
                qaAudioQueue.current.push(audioBuffer);
                playNextQAChunk();
            }
          } catch (e) {
            console.error('Error decoding Q&A audio data:', e);
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
      stopAudio();
      stopQA();
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, [presentationScript, toast, api, currentSlideIndex]);

  useEffect(() => {
    if (!api) {
      return;
    }

    const handleSelect = () => {
      const newSlideIndex = api.selectedScrollSnap();
      if (newSlideIndex === currentSlideIndex) return;

      setCurrentSlideIndex(newSlideIndex);
      stopAudio();
      updateDebug({
        currentSlide: newSlideIndex + 1,
        currentCaption: 'Loading slide...',
        chunksReceived: 0,
        totalChunks: 0,
        lastChunkSize: 0,
      });

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(
          JSON.stringify({ type: 'slide_start', slide_number: newSlideIndex + 1 })
        );
      }
    };

    api.on('select', handleSelect);
    
    if(currentSlideIndex === -1 && presentationScript) {
      setCurrentSlideIndex(0);
      updateDebug({ currentSlide: 1, currentCaption: 'Loading slide...' });
    }

    return () => {
      api.off('select', handleSelect);
    };
  }, [api, currentSlideIndex, presentationScript]);


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
    if (isPlaying.current) {
        stopAudio(true); // Pause main narration
        setTranscribedText('');
        setInterruptOpen(true);
    } else {
        toast({ title: "Cannot Interrupt", description: "No audio is currently playing to interrupt.", variant: "destructive" });
    }
  };

  const askQuestion = () => {
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
    resumeMainAudio();
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
  
  const stopQA = () => {
    if(qaSourceNode.current) {
        qaSourceNode.current.stop();
        qaSourceNode.current = null;
    }
    qaAudioQueue.current = [];
    isPlayingQA.current = false;
  }
  
  const concatenateAudioBuffers = async (buffers: AudioBuffer[]): Promise<AudioBuffer | null> => {
    if (buffers.length === 0 || !audioContext.current) return null;
    
    const totalLength = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
    const concatenatedBuffer = audioContext.current.createBuffer(
      1, totalLength, audioContext.current.sampleRate
    );
    const outputData = concatenatedBuffer.getChannelData(0);
    let offset = 0;
    for (const buffer of buffers) {
      outputData.set(buffer.getChannelData(0), offset);
      offset += buffer.length;
    }
    return concatenatedBuffer;
  }

  const playNextQAChunk = async () => {
    if (isPlayingQA.current || qaAudioQueue.current.length === 0 || !audioContext.current) {
      return;
    }

    isPlayingQA.current = true;
    const bufferToPlay = await concatenateAudioBuffers(qaAudioQueue.current);
    qaAudioQueue.current = []; // Clear queue
    if (!bufferToPlay) return;

    const source = audioContext.current.createBufferSource();
    source.buffer = bufferToPlay;
    source.connect(audioContext.current.destination);
    source.onended = () => {
        isPlayingQA.current = false;
        qaSourceNode.current = null;
    };
    source.start();
    qaSourceNode.current = source;
  }

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
              <td className="pr-2 opacity-70">Last Chunk Size:</td>
              <td className="font-mono">{debugInfo.lastChunkSize} bytes</td>
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

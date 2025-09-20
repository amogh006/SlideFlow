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
import { Expand, Mic, Shrink, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';

interface DebugInfo {
  status: string;
  currentSlide: number;
  totalChunks: number;
  chunksReceived: number;
  lastChunkSize: number;
  audioPlayerState: 'idle' | 'playing' | 'buffering';
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

  const [currentSlideIndex, setCurrentSlideIndex] = useState(-1);

  const [audioProgress, setAudioProgress] = useState(0);
  const totalAudioDuration = useRef(0);
  const playbackStartTime = useRef(0);
  const progressInterval = useRef<NodeJS.Timeout | null>(null);

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
    setDebugInfo(prev => ({...prev, ...newInfo}));
  }

   const stopAudio = () => {
    if (progressInterval.current) {
      clearInterval(progressInterval.current);
      progressInterval.current = null;
    }
    if (sourceNode.current) {
      sourceNode.current.onended = null;
      sourceNode.current.stop();
      sourceNode.current = null;
    }
    audioQueue.current = [];
    isPlaying.current = false;
    setAudioProgress(0);
    totalAudioDuration.current = 0;
    playbackStartTime.current = 0;
    updateDebug({ audioPlayerState: 'idle' });
  };


  const playNextAudioChunk = async () => {
    if (isPlaying.current || audioQueue.current.length === 0) {
      return;
    }
    isPlaying.current = true;
    updateDebug({ audioPlayerState: 'playing' });

    if (!audioContext.current || audioContext.current.state === 'closed') {
      try {
        audioContext.current = new (window.AudioContext ||
          window.webkitAudioContext)();
      } catch (e) {
        console.error('Web Audio API is not supported in this browser', e);
        isPlaying.current = false;
        updateDebug({ audioPlayerState: 'idle' });
        return;
      }
    }
    
    await audioContext.current.resume();
    
    // Concatenate all buffers in the queue
    const totalLength = audioQueue.current.reduce((acc, buffer) => acc + buffer.length, 0);
    const outputBuffer = audioContext.current.createBuffer(
        1,
        totalLength,
        audioContext.current.sampleRate
    );
    const outputData = outputBuffer.getChannelData(0);

    let offset = 0;
    for (const buffer of audioQueue.current) {
        outputData.set(buffer.getChannelData(0), offset);
        offset += buffer.length;
    }
    audioQueue.current = [];
    updateDebug({ chunksReceived: 0 });

    totalAudioDuration.current = outputBuffer.duration;
    
    const source = audioContext.current.createBufferSource();
    source.buffer = outputBuffer;
    source.connect(audioContext.current.destination);
    
    source.onended = () => {
      stopAudio();
    };

    source.start();
    sourceNode.current = source;
    playbackStartTime.current = audioContext.current.currentTime;

    if (progressInterval.current) clearInterval(progressInterval.current);
    progressInterval.current = setInterval(() => {
      if (audioContext.current && isPlaying.current) {
        const elapsedTime = audioContext.current.currentTime - playbackStartTime.current;
        const progress = (elapsedTime / totalAudioDuration.current) * 100;
        setAudioProgress(Math.min(progress, 100));
      }
    }, 100);
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
          // Now that presentation is loaded, start the first slide
          if (currentSlideIndex === 0) {
            newWs.send(JSON.stringify({ type: 'slide_start', slide_number: 1 }));
          }
          break;
        case 'audio_chunk':
          try {
            const audioData = decodeBase64(message.audio_data);
            updateDebug({ 
              chunksReceived: prev => prev.chunksReceived + 1,
              lastChunkSize: audioData.byteLength 
            });
            if (audioContext.current || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))) {
                if(!audioContext.current || audioContext.current.state === 'closed'){
                    audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
                }
              const audioBuffer = await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              updateDebug({ audioPlayerState: 'buffering' });
            }
          } catch (e) {
            console.error('Error decoding audio data:', e);
          }
          break;
        case 'slide_started':
          const slideScript = presentationScript.slides[message.slide_number - 1];
          updateDebug({ currentCaption: slideScript.script, totalChunks: slideScript.script_chunks.length });
          break;
        case 'slide_done':
           if (!message.is_qa) {
             playNextAudioChunk();
           }
          break;
        case 'qa_response':
          const qaCaption = `Q: ${message.question}\nA: ${message.answer}`;
          updateDebug({ currentCaption: qaCaption });
          stopAudio();
          try {
            const audioData = decodeBase64(message.audio_data);
            updateDebug({ lastChunkSize: audioData.byteLength, chunksReceived: 1, totalChunks: 1 });
            if (audioContext.current) {
              const audioBuffer = await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              playNextAudioChunk();
            }
          } catch (e) {
            console.error('Error decoding audio data:', e);
          }
          break;
        case 'error':
          console.error(`WebSocket Error: ${message.message}`);
          updateDebug({ status: `Error: ${message.message}` });
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
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, [presentationScript, toast, currentSlideIndex]);
  
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
        currentCaption: '',
        chunksReceived: 0,
        totalChunks: 0,
        lastChunkSize: 0,
      });

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'slide_start', slide_number: newSlideIndex + 1 }));
      }
    }
    
    api.on('select', handleSelect);
    // Set initial slide after API is ready
    if(currentSlideIndex === -1 && presentationScript){
        setCurrentSlideIndex(0);
        updateDebug({ currentSlide: 1 });
         if (ws.current && ws.current.readyState === WebSocket.OPEN) {
             ws.current.send(JSON.stringify({ type: 'slide_start', slide_number: 1 }));
         }
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
            console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
          });
        } else {
          document.exitFullscreen();
        }
    }
  };

  useEffect(() => {
    if(typeof document === 'undefined') return;
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f') toggleFullScreen();
      if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullScreenChange);
       window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleInterrupt = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      const question = "Can you explain this slide in simpler terms?"; // Hardcoded question
      ws.current.send(JSON.stringify({ type: 'interrupt', question }));
      updateDebug({ currentCaption: `Asking: "${question}"`, audioPlayerState: 'idle' });
      stopAudio();
    }
  };

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
            <tr><td className="pr-2 opacity-70">WS Status:</td><td className="font-mono">{debugInfo.status}</td></tr>
            <tr><td className="pr-2 opacity-70">Slide:</td><td className="font-mono">{debugInfo.currentSlide} / {slides.length}</td></tr>
            <tr><td className="pr-2 opacity-70">Audio State:</td><td className="font-mono">{debugInfo.audioPlayerState}</td></tr>
            <tr><td className="pr-2 opacity-70">Chunks:</td><td className="font-mono">{debugInfo.chunksReceived} / {debugInfo.totalChunks}</td></tr>
            <tr><td className="pr-2 opacity-70">Last Chunk Size:</td><td className="font-mono">{debugInfo.lastChunkSize} bytes</td></tr>
            <tr><td className="pr-2 opacity-70 align-top">Caption:</td><td className="font-mono h-20 overflow-y-auto block">{debugInfo.currentCaption}</td></tr>
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
        <p className="text-center text-xl whitespace-pre-wrap h-20 overflow-y-auto">{debugInfo.currentCaption}</p>
      </div>

       <div className="absolute bottom-0 left-0 right-0 w-full h-1 group-hover:h-2 transition-all">
        <Progress
          value={audioProgress}
          className="w-full h-full bg-gray-500/50 [&>div]:bg-red-600 rounded-none"
        />
      </div>

      <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleInterrupt}
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <Mic className="h-5 w-5" />
          <span className="sr-only">Ask a question</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleFullScreen}
          className="text-white hover:bg-white/10 hover:text-white"
        >
          {isFullScreen ? <Shrink className="h-5 w-5" /> : <Expand className="h-5 w-5" />}
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

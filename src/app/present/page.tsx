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

// Helper to decode Base64
const decodeBase64 = (base64: string) => {
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

  const [currentCaption, setCurrentCaption] = useState('');
  const [currentSlideIndex, setCurrentSlideIndex] = useState(-1);

  useEffect(() => {
    if (!isAuthenticated || slides.length === 0 || !presentationScript) {
      router.push('/upload');
    }
  }, [isAuthenticated, slides, presentationScript, router]);

  const playNextAudioChunk = async () => {
    if (isPlaying.current || audioQueue.current.length === 0) {
      return;
    }
    isPlaying.current = true;

    if (!audioContext.current) {
      try {
        audioContext.current = new (window.AudioContext ||
          window.webkitAudioContext)();
      } catch (e) {
        console.error('Web Audio API is not supported in this browser', e);
        isPlaying.current = false;
        return;
      }
    }

    await audioContext.current.resume();
    const audioBuffer = audioQueue.current.shift()!;
    const source = audioContext.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.current.destination);
    source.onended = () => {
      isPlaying.current = false;
      playNextAudioChunk();
    };
    source.start();
  };

  useEffect(() => {
    if (!presentationScript || ws.current) return;

    const newWs = new WebSocket('ws://147.93.102.137:8000/ws/presentation');
    ws.current = newWs;

    newWs.onopen = () => {
      console.log('WebSocket connected');
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
          break;
        case 'presentation_loaded':
          console.log(message.message);
          // Now that presentation is loaded, start the first slide
          if (api && currentSlideIndex === 0) {
            newWs.send(JSON.stringify({ type: 'slide_start', slide_number: 1 }));
          }
          break;
        case 'audio_chunk':
          try {
            const audioData = decodeBase64(message.audio_data);
            if (audioContext.current) {
              const audioBuffer =
                await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              playNextAudioChunk();
            }
          } catch (e) {
            console.error('Error decoding audio data:', e);
          }
          break;
        case 'slide_started':
          setCurrentCaption(
            presentationScript.slides[message.slide_number - 1].script
          );
          break;
        case 'slide_done':
          setCurrentCaption('');
          break;
        case 'qa_response':
          setCurrentCaption(`Q: ${message.question}\nA: ${message.answer}`);
          try {
            const audioData = decodeBase64(message.audio_data);
            if (audioContext.current) {
              const audioBuffer =
                await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              playNextAudioChunk();
            }
          } catch (e) {
            console.error('Error decoding audio data:', e);
          }
          break;
        case 'error':
          console.error(`WebSocket Error: ${message.message}`);
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
    };

    newWs.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      newWs?.close();
      ws.current = null;
    };
  }, [presentationScript, api, toast, currentSlideIndex]);
  
  useEffect(() => {
    if (!api) {
      return;
    }
  
    const handleSelect = () => {
      const newSlideIndex = api.selectedScrollSnap();
      if (newSlideIndex === currentSlideIndex) return;

      setCurrentSlideIndex(newSlideIndex);

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        // Clear audio queue and stop current playback for new slide
        audioQueue.current = [];
        isPlaying.current = false;
        if(audioContext.current?.state === 'running') {
            audioContext.current.suspend().then(() => audioContext.current?.close());
            audioContext.current = null;
        }

        ws.current.send(JSON.stringify({ type: 'slide_start', slide_number: newSlideIndex + 1 }));
      }
    }
    
    api.on('select', handleSelect);
    // Set initial slide after API is ready
    if(currentSlideIndex === -1){
        setCurrentSlideIndex(0);
    }
  
    return () => {
      api.off('select', handleSelect);
    };
  }, [api, currentSlideIndex]);


  const handleFullScreenChange = () => {
    setIsFullScreen(!!document.fullscreenElement);
  };

  const toggleFullScreen = () => {
    const element = carouselContainerRef.current;
    if (!element) return;

    if (!document.fullscreenElement) {
      element.requestFullscreen().catch((err) => {
        console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
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
      setCurrentCaption(`Asking: "${question}"`);
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
        <p className="text-center text-xl whitespace-pre-wrap">{currentCaption}</p>
      </div>

      <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
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

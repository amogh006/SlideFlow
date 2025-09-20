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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Expand, Mic, Shrink, X, Hand, MicOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';

interface DebugInfo {
  status: string;
  currentSlide: number;
  totalChunks: number;
  chunksReceived: number;
  lastChunkSize: number;
  audioPlayerState: 'idle' | 'playing' | 'buffering' | 'paused';
  currentCaption: string;
}

// Check for SpeechRecognition API
const SpeechRecognition =
  typeof window !== 'undefined'
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

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
  const narrationSourceNode = useRef<AudioBufferSourceNode | null>(null);
  const qaSourceNode = useRef<AudioBufferSourceNode | null>(null);
  const mainAudioBuffer = useRef<AudioBuffer | null>(null);
  const resumeState = useRef<{ buffer: AudioBuffer; playedDuration: number } | null>(null);

  const [currentSlideIndex, setCurrentSlideIndex] = useState(-1);

  const [audioProgress, setAudioProgress] = useState(0);
  const totalAudioDuration = useRef(0);
  const playbackStartTime = useRef(0);
  const pausedTime = useRef(0);
  const progressInterval = useRef<NodeJS.Timeout | null>(null);

  // Interrupt and ASR state
  const [isInterruptPopupOpen, setInterruptPopupOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const recognition = useRef<any | null>(null);
  const [qaAnswer, setQaAnswer] = useState('');


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

  const stopNarration = (isPausing = false) => {
    if (progressInterval.current) {
      clearInterval(progressInterval.current);
      progressInterval.current = null;
    }

    if (narrationSourceNode.current) {
        if (isPausing && mainAudioBuffer.current && audioContext.current) {
            pausedTime.current = audioContext.current.currentTime - playbackStartTime.current;
            resumeState.current = { buffer: mainAudioBuffer.current, playedDuration: pausedTime.current };
            updateDebug({ audioPlayerState: 'paused' });
        } else {
             resumeState.current = null;
        }

      narrationSourceNode.current.onended = null;
      try { narrationSourceNode.current.stop(); } catch (e) { console.warn("Narration stop error:", e) }
      narrationSourceNode.current = null;
    }
    
    if (!isPausing) {
        audioQueue.current = [];
        mainAudioBuffer.current = null;
        setAudioProgress(0);
        totalAudioDuration.current = 0;
        playbackStartTime.current = 0;
        pausedTime.current = 0;
        updateDebug({ audioPlayerState: 'idle' });
    }
    isPlaying.current = false;
  };

  const stopQaAudio = () => {
    if(qaSourceNode.current) {
      qaSourceNode.current.onended = null;
      try { qaSourceNode.current.stop() } catch(e) { console.warn("QA Audio stop error:", e) }
      qaSourceNode.current = null;
    }
  }


  const playNextAudioChunk = async (isQA = false) => {
    if (isQA) {
      stopQaAudio();
    } else {
      if (isPlaying.current || (audioQueue.current.length === 0 && !resumeState.current)) {
          return;
      }
    }
    
    let bufferToPlay: AudioBuffer | null = null;
    let resumeFrom = 0;

    if (!isQA && resumeState.current) {
        bufferToPlay = resumeState.current.buffer;
        resumeFrom = resumeState.current.playedDuration;
        resumeState.current = null;
        updateDebug({ currentCaption: presentationScript?.slides[currentSlideIndex].script ?? 'Resuming...' });
    } else if (audioQueue.current.length > 0) {
        if (!audioContext.current || audioContext.current.state === 'closed') {
          try { audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } 
          catch (e) { console.error('Web Audio API is not supported.', e); return; }
        }
        await audioContext.current.resume();
        bufferToPlay = audioQueue.current.shift()!;
    } else { return; }
    
    if (!bufferToPlay) return;

    if (!isQA) mainAudioBuffer.current = bufferToPlay;

    isPlaying.current = true;
    updateDebug({ audioPlayerState: 'playing' });

    if (resumeFrom === 0) totalAudioDuration.current += bufferToPlay.duration;
    
    const source = audioContext.current!.createBufferSource();
    source.buffer = bufferToPlay;
    source.connect(audioContext.current!.destination);
    
    const onEnded = () => {
      if(isQA) {
        qaSourceNode.current = null;
      } else {
        narrationSourceNode.current = null;
        isPlaying.current = false;
        mainAudioBuffer.current = null; 
        if (audioQueue.current.length > 0) {
            playNextAudioChunk(false);
        } else {
            updateDebug({ audioPlayerState: 'idle' });
        }
      }
    };
    source.onended = onEnded;

    source.start(0, resumeFrom); 

    if (isQA) {
      qaSourceNode.current = source;
    } else {
      narrationSourceNode.current = source;
      playbackStartTime.current = audioContext.current!.currentTime - resumeFrom;
          
      if (progressInterval.current) clearInterval(progressInterval.current);
      progressInterval.current = setInterval(() => {
        if (audioContext.current && isPlaying.current) {
          const elapsedTime = (audioContext.current.currentTime - playbackStartTime.current);
          const progress = (elapsedTime / totalAudioDuration.current) * 100;
          setAudioProgress(Math.min(progress, 100));
        }
      }, 100);
    }
  };


  useEffect(() => {
    if (!presentationScript || ws.current) return;

    const newWs = new WebSocket('ws://147.93.102.137:8000/ws/presentation');
    ws.current = newWs;
    updateDebug({ status: 'Connecting...' });

    newWs.onopen = () => {
      updateDebug({ status: 'Connected' });
      newWs.send(JSON.stringify({ type: 'load_presentation', data: presentationScript }));
    };

    newWs.onmessage = async (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'connected':
          updateDebug({ status: 'Connected (Server ACK)' });
          break;
        case 'presentation_loaded':
          updateDebug({ status: 'Presentation Loaded' });
          if (currentSlideIndex === 0) {
            newWs.send(JSON.stringify({ type: 'slide_start', slide_number: 1 }));
          }
          break;
        case 'audio_chunk':
          try {
            const audioData = decodeBase64(message.audio_data);
            updateDebug({ chunksReceived: p => p + 1, lastChunkSize: audioData.byteLength });
            if (audioContext.current || (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext))) {
                if(!audioContext.current || audioContext.current.state === 'closed'){ audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)(); }
              const audioBuffer = await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.push(audioBuffer);
              updateDebug({ audioPlayerState: 'buffering' });
              if (!isPlaying.current) playNextAudioChunk(false);
            }
          } catch (e) { console.error('Error decoding audio data:', e); }
          break;
        case 'slide_started':
           stopNarration();
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
          break;
        case 'qa_response':
          setQaAnswer(message.answer);
          try {
            const audioData = decodeBase64(message.audio_data);
            if (audioContext.current) {
              const audioBuffer = await audioContext.current.decodeAudioData(audioData);
              audioQueue.current.unshift(audioBuffer); // Use unshift to play it next
              playNextAudioChunk(true);
            }
          } catch (e) { console.error('Error decoding Q&A audio data:', e); }
          break;
        case 'error':
          updateDebug({ status: `Error: ${message.message}` });
          toast({ title: 'Presentation Error', description: message.message, variant: 'destructive' });
          break;
      }
    };

    newWs.onclose = () => updateDebug({ status: 'Disconnected' });
    newWs.onerror = (error) => { console.error('WebSocket error:', error); updateDebug({ status: 'Error' }); };

    return () => {
      newWs?.close();
      ws.current = null;
      stopNarration();
      stopQaAudio();
      audioContext.current?.close();
    };
  }, [presentationScript, toast, api]);
  
  useEffect(() => {
    if (!api) return;
  
    const handleSelect = () => {
      const newSlideIndex = api.selectedScrollSnap();
      if (newSlideIndex === currentSlideIndex) return;
      
      setCurrentSlideIndex(newSlideIndex);
      stopNarration();
      updateDebug({ currentSlide: newSlideIndex + 1, currentCaption: 'Loading slide...', chunksReceived: 0, totalChunks: 0, lastChunkSize: 0 });

      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'slide_start', slide_number: newSlideIndex + 1 }));
      }
    }
    
    api.on('select', handleSelect);
    if(currentSlideIndex === -1 && presentationScript){
        setCurrentSlideIndex(0);
        updateDebug({ currentSlide: 1, currentCaption: 'Loading slide...' });
         if (ws.current?.readyState === WebSocket.OPEN && presentationScript.slides.length > 0) {
             ws.current.send(JSON.stringify({ type: 'slide_start', slide_number: 1 }));
         }
    }
  
    return () => { api.off('select', handleSelect); };
  }, [api, currentSlideIndex, presentationScript]);

  // ASR Effect
  useEffect(() => {
    if (!SpeechRecognition) return;

    recognition.current = new SpeechRecognition();
    recognition.current.continuous = true;
    recognition.current.interimResults = true;

    recognition.current.onresult = (event: any) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      setTranscribedText(prev => prev + finalTranscript);
    };

    recognition.current.onstart = () => setIsListening(true);
    recognition.current.onend = () => setIsListening(false);
    recognition.current.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      toast({ title: "Speech Recognition Error", description: event.error, variant: "destructive" });
    };

    return () => {
      recognition.current?.stop();
    };
  }, [toast]);


  const toggleListening = () => {
    if (isListening) {
      recognition.current?.stop();
    } else {
      setTranscribedText('');
      setQaAnswer('');
      recognition.current?.start();
    }
  };

  const handleInterrupt = () => {
    stopNarration(true);
    setInterruptPopupOpen(true);
  };

  const handlePopupClose = (open: boolean) => {
    if (!open) {
      setInterruptPopupOpen(false);
      recognition.current?.stop();
      stopQaAudio();
      setTranscribedText('');
      setQaAnswer('');
      if (resumeState.current) {
        playNextAudioChunk(false);
      }
    }
  };

  const askQuestion = () => {
    if (ws.current?.readyState === WebSocket.OPEN && transcribedText) {
      recognition.current?.stop();
      ws.current.send(JSON.stringify({ type: 'interrupt', question: transcribedText }));
      setQaAnswer('Getting answer...');
    }
  }


  const toggleFullScreen = () => {
    const element = carouselContainerRef.current;
    if (!element || typeof document === 'undefined') return;
    if (!document.fullscreenElement) {
      element.requestFullscreen().catch(err => console.error(`FS error: ${err.message}`));
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if(typeof document === 'undefined') return;
    const handleFullScreenChange = () => setIsFullScreen(!!document.fullscreenElement);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f') toggleFullScreen();
      if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
    };
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullScreenChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);


  if (!isAuthenticated || slides.length === 0) {
    return null;
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
                <Image src={slideUrl} alt={`Slide ${index + 1}`} width={1920} height={1080} className="w-auto h-auto max-w-full max-h-full object-contain" />
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="absolute left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 hover:bg-black/75 border-none text-white h-12 w-12" />
        <CarouselNext className="absolute right-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 hover:bg-black/75 border-none text-white h-12 w-12" />
      </Carousel>
      
      <Dialog open={isInterruptPopupOpen} onOpenChange={handlePopupClose}>
        <DialogContent className="sm:max-w-[425px] bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>Ask a Question</DialogTitle>
            <DialogDescription>
              Click the mic to start recording your question. The presentation will resume when you close this popup.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex items-center justify-center">
              <Button size="icon" variant={isListening ? "destructive" : "outline"} onClick={toggleListening} className="rounded-full w-16 h-16">
                {isListening ? <MicOff className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground h-12 overflow-y-auto">Q: {transcribedText || "..."}</p>
            <p className="text-sm h-24 overflow-y-auto">A: {qaAnswer || "..."}</p>
          </div>
          <DialogFooter>
             <Button onClick={askQuestion} disabled={!transcribedText || isListening}>Ask</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-center text-xl whitespace-pre-wrap h-20 overflow-y-auto">{debugInfo.currentCaption}</p>
      </div>

       <div className="absolute bottom-0 left-0 right-0 w-full h-1 group-hover:h-2 transition-all">
        <Progress value={audioProgress} className="w-full h-full bg-gray-500/50 [&gt;div]:bg-red-600 rounded-none" />
      </div>

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
          {isFullScreen ? <Shrink className="h-5 w-5" /> : <Expand className="h-5 w-5" />}
          <span className="sr-only">Toggle Fullscreen</span>
        </Button>
        <Button asChild variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white">
          <Link href="/upload">
            <X className="h-5 w-5" />
            <span className="sr-only">Exit Presentation</span>
          </Link>
        </Button>
      </div>
    </div>
  );
}

    
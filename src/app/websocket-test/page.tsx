'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppContext } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { ArrowLeft, Send, Play, Pause, StopCircle, HelpCircle, RefreshCw, Radio, Music } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

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


export default function WebSocketTestPage() {
  const { isAuthenticated, presentationScript } = useAppContext();
  const router = useRouter();
  const { toast } = useToast();

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState('Disconnected');
  const [messages, setMessages] = useState<any[]>([]);

  // Input states
  const [slideNumber, setSlideNumber] = useState('1');
  const [question, setQuestion] = useState('Can you explain this in simpler terms?');
  const [voice, setVoice] = useState('alloy');
  const [model, setModel] = useState('tts-1');
  const [speed, setSpeed] = useState('1.0');

  // Audio state
  const audioContext = useRef<AudioContext | null>(null);
  const audioQueue = useRef<AudioBuffer[]>([]);
  const isPlaying = useRef(false);
  const sourceNode = useRef<AudioBufferSourceNode | null>(null);
  const [bufferedChunks, setBufferedChunks] = useState(0);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
    }
    
    // Initialize AudioContext
    if (typeof window !== 'undefined' && !audioContext.current) {
        try {
            audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.error("Web Audio API is not supported.", e);
            toast({ title: "Audio Error", description: "Web Audio API is not supported in this browser.", variant: "destructive" });
        }
    }

    return () => {
        ws?.close();
        audioContext.current?.close();
    }
  }, [isAuthenticated, router, toast, ws]);

  const stopAudio = () => {
    if (sourceNode.current) {
      sourceNode.current.onended = null;
      sourceNode.current.stop();
      sourceNode.current = null;
    }
    audioQueue.current = [];
    setBufferedChunks(0);
    isPlaying.current = false;
  };

  const playNextAudioChunk = async () => {
    if (isPlaying.current || audioQueue.current.length === 0) {
      if(audioQueue.current.length === 0) {
        toast({title: "Audio", description: "No audio chunks in buffer."});
      }
      return;
    }
    isPlaying.current = true;

    if (!audioContext.current || audioContext.current.state === 'closed') {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    await audioContext.current.resume();

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
    
    // Clear queue after concatenating
    audioQueue.current = [];
    setBufferedChunks(0);

    const source = audioContext.current.createBufferSource();
    source.buffer = outputBuffer;
    source.connect(audioContext.current.destination);
    source.onended = () => {
      isPlaying.current = false;
      sourceNode.current = null;
      addMessage({type: 'local_event', message: "Audio playback finished."});
    };
    source.start();
    sourceNode.current = source;
    addMessage({type: 'local_event', message: `Playing ${outputBuffer.duration.toFixed(2)}s of audio.`});
  };

  const connect = () => {
    if (ws) {
      ws.close();
    }
    const newWs = new WebSocket('ws://147.93.102.137:8000/ws/presentation');
    
    newWs.onopen = () => {
      setStatus('Connected');
      addMessage({ type: 'local_event', message: 'WebSocket Connected' });
    };

    newWs.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      addMessage(message);

      if (message.type === 'audio_chunk' || (message.type === 'qa_response' && message.audio_data)) {
        try {
            const audioData = decodeBase64(message.audio_data);
            if (audioContext.current) {
                const audioBuffer = await audioContext.current.decodeAudioData(audioData);
                audioQueue.current.push(audioBuffer);
                setBufferedChunks(prev => prev + 1);

                // If it's a Q&A response, play it immediately
                if (message.type === 'qa_response') {
                    stopAudio(); // Stop any currently playing audio
                    audioQueue.current.push(audioBuffer); // Re-add the buffer since stopAudio clears it
                    setBufferedChunks(1);
                    playNextAudioChunk();
                }
            }
        } catch (e) {
            console.error('Error decoding audio data:', e);
            addMessage({ type: 'local_error', message: 'Failed to decode audio data.' });
        }
      }
    };

    newWs.onerror = (error) => {
      console.error('WebSocket Error:', error);
      setStatus('Error');
      addMessage({ type: 'local_error', message: 'WebSocket error occurred.' });
    };

    newWs.onclose = () => {
      setStatus('Disconnected');
      addMessage({ type: 'local_event', message: 'WebSocket Disconnected' });
      setWs(null);
    };

    setWs(newWs);
  };

  const disconnect = () => {
    ws?.close();
  };
  
  const addMessage = (msg: any) => {
    setMessages((prev) => [{ ...msg, timestamp: new Date().toLocaleTimeString() }, ...prev]);
  };

  const sendMessage = (payload: any) => {
    if (ws?.readyState === WebSocket.OPEN) {
      const msgString = JSON.stringify(payload);
      ws.send(msgString);
      addMessage({ type: 'client_message', ...payload });
    } else {
      toast({
        title: 'Not Connected',
        description: 'WebSocket is not connected. Please connect first.',
        variant: 'destructive',
      });
    }
  };

  const handleLoadPresentation = () => {
    if (!presentationScript) {
      toast({
        title: 'No Script',
        description: 'Please upload a presentation first to generate a script.',
        variant: 'destructive',
      });
      return;
    }
    sendMessage({ type: 'load_presentation', data: presentationScript });
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
       <header className="sticky top-0 z-10 flex items-center justify-between h-16 px-4 md:px-6 border-b bg-white">
        <div className="flex items-center gap-4">
          <Button asChild variant="outline" size="icon">
            <Link href="/upload">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">WebSocket Test Bench</h1>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant={status === 'Connected' ? 'default' : 'destructive'} className="capitalize">{status}</Badge>
          {status === 'Connected' ? (
             <Button onClick={disconnect} variant="destructive">Disconnect</Button>
          ) : (
            <Button onClick={connect}>Connect</Button>
          )}
        </div>
      </header>
      <main className="flex-1 p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle>Audio Control</CardTitle></CardHeader>
            <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Buffered Chunks:</span>
                    <Badge variant="secondary">{bufferedChunks}</Badge>
                </div>
                 <div className="grid grid-cols-2 gap-2">
                    <Button onClick={playNextAudioChunk}><Music className="mr-2"/> Play Buffered Audio</Button>
                    <Button onClick={stopAudio} variant="destructive"><StopCircle className="mr-2"/> Stop & Clear</Button>
                 </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>1. Load Presentation</CardTitle></CardHeader>
            <CardContent>
              <Button onClick={handleLoadPresentation} className="w-full" disabled={!presentationScript}>
                <Send className="mr-2" /> Load Script
              </Button>
              {!presentationScript && <p className="text-xs text-muted-foreground mt-2">Upload a presentation on the main page to enable this.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>2. Presentation Control</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Input type="number" value={slideNumber} onChange={(e) => setSlideNumber(e.target.value)} placeholder="Slide #" className="w-24" />
                <Button onClick={() => sendMessage({ type: 'slide_start', slide_number: parseInt(slideNumber, 10) })} className="flex-1">
                  <Play className="mr-2" /> Start Slide
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                 <Button onClick={() => sendMessage({ type: 'resume' })} variant="secondary"><Play className="mr-2"/> Resume</Button>
                 <Button onClick={() => sendMessage({ type: 'stop' })} variant="destructive"><StopCircle className="mr-2"/> Stop</Button>
              </div>
            </CardContent>
          </Card>
           <Card>
            <CardHeader><CardTitle>3. Interrupt (Q&A)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
                <Label htmlFor="question">Question</Label>
                <Textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} />
                <Button onClick={() => sendMessage({ type: 'interrupt', question })} className="w-full">
                  <HelpCircle className="mr-2" /> Ask Question
                </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>4. Other Commands</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              <Button onClick={() => sendMessage({ type: 'get_status' })} variant="outline"><RefreshCw className="mr-2" /> Get Status</Button>
              <Button onClick={() => sendMessage({ type: 'ping' })} variant="outline"><Radio className="mr-2" /> Ping</Button>
            </CardContent>
          </Card>
           <Card>
            <CardHeader><CardTitle>5. Configure TTS</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Voice</Label>
                <Select value={voice} onValueChange={setVoice}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alloy">alloy</SelectItem>
                    <SelectItem value="echo">echo</SelectItem>
                    <SelectItem value="fable">fable</SelectItem>
                    <SelectItem value="onyx">onyx</SelectItem>
                    <SelectItem value="nova">nova</SelectItem>
                    <SelectItem value="shimmer">shimmer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                 <Select value={model} onValueChange={setModel}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tts-1">tts-1</SelectItem>
                    <SelectItem value="tts-1-hd">tts-1-hd</SelectItem>
                  </SelectContent>
                </Select>
              </div>
               <div className="space-y-2">
                <Label>Speed</Label>
                <Input type="number" value={speed} onChange={e => setSpeed(e.target.value)} step="0.1" min="0.25" max="4.0" />
              </div>
              <Button onClick={() => sendMessage({ type: 'configure_tts', voice, model, speed: parseFloat(speed) })} className="w-full">
                  <Send className="mr-2" /> Configure
              </Button>
            </CardContent>
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Card className="h-full flex flex-col">
            <CardHeader><CardTitle>WebSocket Log</CardTitle></CardHeader>
            <CardContent className="flex-1 overflow-auto bg-gray-900 text-white font-mono text-xs rounded-b-lg">
                <pre className="p-4 whitespace-pre-wrap">{JSON.stringify(messages, null, 2)}</pre>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

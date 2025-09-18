'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAppContext } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  UploadCloud,
  X,
  Presentation,
  LogOut,
  Loader2,
  KeyRound,
  TestTube,
} from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';

type LoadingState = 'idle' | 'converting' | 'scripting' | 'done' | 'error';

export default function UploadPage() {
  const {
    isAuthenticated,
    logout,
    file,
    setFile,
    setSlides,
    slides,
    setPresentationScript,
    apiKey,
    setApiKey,
    presentationScript,
  } = useAppContext();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, router]);
  
  useEffect(() => {
    if(file && presentationScript) {
        setLoadingState('done');
    } else if (file && slides.length > 0 && !presentationScript) {
        setLoadingState('scripting');
    } else if (file && slides.length === 0) {
        setLoadingState('converting');
    } else {
        setLoadingState('idle');
    }
  }, [file, slides, presentationScript]);


  const generateScript = async (slidesResponse: any, title: string) => {
    setLoadingState('scripting');
    setLoadingProgress(50);
    setLoadingMessage('Generating presentation script...');

    const scriptFormData = new FormData();
    const blob = new Blob([JSON.stringify(slidesResponse)], {
      type: 'application/json',
    });
    scriptFormData.append('file', blob, 'slides_response.json');
    scriptFormData.append('presentation_title', title);
    scriptFormData.append('openai_api_key', apiKey);

    try {
      const response = await fetch('/api/generate-script', {
        method: 'POST',
        body: scriptFormData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to generate script.');
      }

      const scriptData = await response.json();
      setPresentationScript(scriptData);
      setLoadingProgress(100);
      setLoadingMessage('Script generated successfully!');
      setLoadingState('done');
      toast({
        title: 'Script Generated',
        description: 'Your presentation script is ready.',
      });
    } catch (error) {
      console.error('Error generating script:', error);
      setLoadingState('error');
      setLoadingMessage('Script generation failed.');
      toast({
        title: 'Script Generation Failed',
        description:
          error instanceof Error
            ? error.message
            : 'An unknown error occurred.',
        variant: 'destructive',
      });
    }
  };

  const processFile = async (selectedFile: File) => {
    if (!apiKey) {
      toast({
        title: 'API Key Required',
        description: 'Please enter your OpenAI API key to proceed.',
        variant: 'destructive',
      });
      return;
    }

    setFile(selectedFile);
    setSlides([]);
    setPresentationScript(null);
    setLoadingState('converting');
    setLoadingProgress(0);
    setLoadingMessage('Processing your presentation...');

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to convert presentation.');
      }

      const data = await response.json();

      if (data.status === 'success' && data.slides) {
        const imageUrls = data.slides.map(
          (slide: { image_data: string; content_type: string }) =>
            `data:${slide.content_type};base64,${slide.image_data}`
        );
        setSlides(imageUrls);
        setLoadingProgress(25);
        setLoadingMessage('Presentation processed, generating script...');
        await generateScript(data, selectedFile.name);
      } else {
        throw new Error('Invalid response from server.');
      }
    } catch (error) {
      console.error('Error processing file:', error);
      setLoadingState('error');
      setLoadingMessage('File processing failed.');
      toast({
        title: 'Processing Failed',
        description:
          error instanceof Error ? error.message : 'An unknown error occurred.',
        variant: 'destructive',
      });
      setFile(null);
      setSlides([]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      processFile(selectedFile);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (
      droppedFile &&
      (droppedFile.type.includes('presentation') ||
        droppedFile.name.endsWith('.ppt') ||
        droppedFile.name.endsWith('.pptx'))
    ) {
      processFile(droppedFile);
    } else {
      toast({
        title: 'Invalid File Type',
        description: 'Please drop a .ppt or .pptx file.',
        variant: 'destructive',
      });
    }
  };

  const handleRemoveFile = () => {
    setFile(null);
    setSlides([]);
    setPresentationScript(null);
    setLoadingState('idle');
    setLoadingProgress(0);
    setLoadingMessage('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/');
  };

  if (!isAuthenticated) {
    return null; // or a loading spinner
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-10 flex items-center justify-between h-16 px-4 md:px-6 border-b bg-card/80 backdrop-blur-sm">
        <Link href="/upload" className="flex items-center gap-2">
          <Presentation className="h-6 w-6 text-primary" />
          <span className="text-lg font-semibold">SlideFlow</span>
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/websocket-test">
              <TestTube className="mr-2 h-4 w-4" />
              WebSocket Test
            </Link>
          </Button>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-5 w-5" />
            <span className="sr-only">Logout</span>
          </Button>
        </div>
      </header>
      <main className="flex-1 p-4 md:p-8 lg:p-12">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Upload Your Presentation</h1>
            <p className="text-muted-foreground">
              Upload a .ppt or .pptx file. We'll generate a preview and a
              presentation script.
            </p>
          </div>

          <Card className="mb-8 p-6 bg-card/30">
            <div className="space-y-2">
              <Label htmlFor="api-key" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                OpenAI API Key
              </Label>
              <Input
                id="api-key"
                type="password"
                placeholder="Enter your OpenAI API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Your API key is used to generate the presentation script. It is
                not stored.
              </p>
            </div>
          </Card>

          {loadingState === 'idle' ? (
            <div
              className={`w-full border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center text-center transition-colors bg-card/30 ${
                !apiKey
                  ? 'cursor-not-allowed'
                  : 'cursor-pointer hover:border-primary'
              }`}
              onClick={() =>
                apiKey && fileInputRef.current?.click()
              }
              onDragOver={handleDragOver}
              onDrop={!apiKey ? undefined : handleDrop}
            >
              <UploadCloud className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-lg font-semibold mb-2">
                Drag & drop your file here
              </p>
              <p className="text-muted-foreground mb-4">or</p>
              <Button type="button" disabled={!apiKey} onClick={() => fileInputRef.current?.click()}>
                Browse Files
              </Button>
              {!apiKey && (
                <p className="text-sm text-destructive mt-4">
                  Please enter your OpenAI API key to upload.
                </p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                accept=".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                disabled={!apiKey}
              />
            </div>
          ) : loadingState === 'converting' || loadingState === 'scripting' ? (
             <div
              className={`w-full border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center text-center transition-colors bg-card/30 cursor-not-allowed`}
            >
                  <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
                  <p className="text-lg font-semibold mb-2">
                    {loadingMessage}
                  </p>
                  <Progress value={loadingProgress} className="w-full max-w-sm mt-4" />
                   <p className="text-muted-foreground mt-2">
                    Please keep this window open.
                  </p>
            </div>
          ) : (
            <div>
              <Card className="mb-8 bg-card/80 backdrop-blur-sm">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Presentation className="h-8 w-8 text-primary" />
                    <div>
                      <p className="font-semibold">{file?.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {file && (file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild disabled={loadingState !== 'done'}>
                      <Link href="/present">Present</Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleRemoveFile}
                    >
                      <X className="h-5 w-5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <h2 className="text-2xl font-bold mb-4">Slide Preview</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {slides.map((slideUrl, index) => (
                  <Card
                    key={index}
                    className="overflow-hidden group shadow-lg"
                  >
                    <div className="aspect-[4/3] relative">
                      <Image
                        src={slideUrl}
                        alt={`Slide ${index + 1}`}
                        fill
                        className="object-cover transition-transform group-hover:scale-105"
                      />
                      <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-md">
                        Slide {index + 1}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

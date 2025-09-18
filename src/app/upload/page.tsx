'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAppContext } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { UploadCloud, X, Presentation, LogOut, Loader2 } from 'lucide-react';
import { PlaceHolderImages } from '@/lib/placeholder-images';
import Link from 'next/link';
import { useToast } from '@/hooks/use-toast';

export default function UploadPage() {
  const {
    isAuthenticated,
    logout,
    file,
    setFile,
    setSlides,
    slides,
    isLoading,
    setIsLoading,
  } = useAppContext();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, router]);

  const processFile = async (selectedFile: File) => {
    setFile(selectedFile);
    setIsLoading(true);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const response = await fetch('http://147.93.102.137:8000/convert-ppt/', {
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
      } else {
        throw new Error('Invalid response from server.');
      }
    } catch (error) {
      console.error('Error processing file:', error);
      toast({
        title: 'Processing Failed',
        description:
          error instanceof Error ? error.message : 'An unknown error occurred.',
        variant: 'destructive',
      });
      setFile(null);
      setSlides([]);
    } finally {
      setIsLoading(false);
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
        <Button variant="ghost" size="icon" onClick={handleLogout}>
          <LogOut className="h-5 w-5" />
          <span className="sr-only">Logout</span>
        </Button>
      </header>
      <main className="flex-1 p-4 md:p-8 lg:p-12">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-3xl font-bold mb-2">Upload Your Presentation</h1>
          <p className="text-muted-foreground mb-8">
            Upload a .ppt or .pptx file to get started. We'll generate a preview
            for you.
          </p>

          {!file ? (
            <div
              className={`w-full border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center text-center transition-colors bg-card/30 ${
                isLoading
                  ? 'cursor-not-allowed'
                  : 'cursor-pointer hover:border-primary'
              }`}
              onClick={() => !isLoading && fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDrop={isLoading ? undefined : handleDrop}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
                  <p className="text-lg font-semibold mb-2">
                    Processing your presentation...
                  </p>
                  <p className="text-muted-foreground">
                    This may take a moment.
                  </p>
                </>
              ) : (
                <>
                  <UploadCloud className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-semibold mb-2">
                    Drag & drop your file here
                  </p>
                  <p className="text-muted-foreground mb-4">or</p>
                  <Button type="button">Browse Files</Button>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                accept=".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                disabled={isLoading}
              />
            </div>
          ) : (
            <div>
              <Card className="mb-8 bg-card/80 backdrop-blur-sm">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Presentation className="h-8 w-8 text-primary" />
                    <div>
                      <p className="font-semibold">{file.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild>
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

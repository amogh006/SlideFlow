'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';

// Define the shape of a single slide's script
export interface SlideScript {
  slide_number: number;
  script: string;
  key_points: string[];
  visual_cues: string[];
  transition: string;
  estimated_time_seconds: number;
  slide_title: string;
}

// Define the shape of the entire presentation script
export interface PresentationScript {
  presentation_info: {
    title: string;
    total_slides: number;
  };
  slides: SlideScript[];
}


interface AppContextType {
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
  file: File | null;
  setFile: (file: File | null) => void;
  slides: string[];
  setSlides: (slides: string[]) => void;
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
  presentationScript: PresentationScript | null;
  setPresentationScript: (script: PresentationScript | null) => void;
  apiKey: string;
  setApiKey: (key: string) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [slides, setSlides] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [presentationScript, setPresentationScript] = useState<PresentationScript | null>(null);
  const [apiKey, setApiKey] = useState('');


  const login = () => setIsAuthenticated(true);
  const logout = () => {
    setIsAuthenticated(false);
    setFile(null);
    setSlides([]);
    setPresentationScript(null);
  };

  return (
    <AppContext.Provider
      value={{
        isAuthenticated,
        login,
        logout,
        file,
        setFile,
        slides,
        setSlides,
        isLoading,
        setIsLoading,
        presentationScript,
        setPresentationScript,
        apiKey,
        setApiKey,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}

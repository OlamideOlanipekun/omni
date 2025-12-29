
import React, { useState, useEffect, useRef, useCallback } from 'react';
// Fix: Import Modality from @google/genai as per guidelines
import { GoogleGenAI, LiveServerMessage, Type, FunctionDeclaration, Modality } from '@google/genai';
import { BookingDetails, ConnectionState, LogEntry, User, Toast } from './types.ts';
import { createPcmBlob, decodeAudioData, base64ToArrayBuffer } from './utils/audioUtils.ts';
import Waveform from './components/Waveform.tsx';
import AuthPage from './components/AuthPage.tsx';
import BackToTop from './components/BackToTop.tsx';
// Fix: Added ShieldCheck to lucide-react imports to resolve line 392 error
import { LogOut, Calendar, Phone, Mail, Menu, X, User as UserIcon, Sparkles, ShieldCheck } from 'lucide-react';

// --- Mock Backend Services & Pricing Logic ---

const ROOM_RATES: Record<string, number> = {
  'standard': 150,
  'double': 180,
  'deluxe': 250,
  'family': 300,
  'suite': 450,
  'presidential': 1200
};

const calculateStayCost = (checkIn: string, checkOut: string, roomType: string) => {
  try {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
    
    const key = Object.keys(ROOM_RATES).find(r => roomType.toLowerCase().includes(r)) || 'standard';
    const rate = ROOM_RATES[key];
    
    return {
      nights: nights || 1,
      rate: rate,
      total: (nights || 1) * rate
    };
  } catch (e) {
    return null;
  }
};

const MockDatabase = {
  saveBooking: (booking: BookingDetails) => {
    const existing = JSON.parse(localStorage.getItem('omni_bookings') || '[]');
    const newBooking = { 
      ...booking, 
      id: crypto.randomUUID(), 
      created_at: new Date().toISOString(),
      status: 'confirmed' 
    };
    existing.unshift(newBooking);
    localStorage.setItem('omni_bookings', JSON.stringify(existing));
    return newBooking;
  },
  getBookings: (userEmail: string) => {
    const all = JSON.parse(localStorage.getItem('omni_bookings') || '[]');
    return all.filter((b: BookingDetails) => b.email === userEmail);
  },
  cancelBooking: (confirmationCode: string) => {
    const all = JSON.parse(localStorage.getItem('omni_bookings') || '[]');
    let found = false;
    const updated = all.map((b: BookingDetails) => {
      if (b.confirmation_code === confirmationCode) {
        found = true;
        return { ...b, status: 'cancelled' };
      }
      return b;
    });
    localStorage.setItem('omni_bookings', JSON.stringify(updated));
    return found;
  },
  sendConfirmationEmail: async (email: string, booking: BookingDetails) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log(`[Mock Email] Confirmation for ${booking.confirmation_code} sent to ${email}`);
        resolve(true);
      }, 2000);
    });
  }
};

// --- Tool Definitions ---

const checkAvailabilityTool: FunctionDeclaration = {
  name: 'check_availability',
  description: 'Checks availability and calculates pricing. Essential for room selection.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      room_type: { type: Type.STRING },
      check_in_date: { type: Type.STRING },
      check_out_date: { type: Type.STRING },
      guests: { type: Type.STRING }
    },
    required: ['room_type', 'check_in_date', 'check_out_date'],
  },
};

const finalizeBookingTool: FunctionDeclaration = {
  name: 'finalize_booking',
  description: 'Call this ONLY when the user explicitly confirms they want to book at the quoted price.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING },
      phone: { type: Type.STRING },
      room_type: { type: Type.STRING },
      check_in_date: { type: Type.STRING },
      check_out_date: { type: Type.STRING },
      total_cost: { type: Type.NUMBER },
    },
    required: ['name', 'phone', 'room_type', 'check_in_date', 'check_out_date'],
  },
};

const cancelBookingTool: FunctionDeclaration = {
  name: 'cancel_booking',
  description: 'Cancels a reservation using a confirmation code.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      confirmation_code: { type: Type.STRING },
    },
    required: ['confirmation_code'],
  },
};

const VOICE_OPTIONS = [
  { label: 'Professional', value: 'Kore' },
  { label: 'Warm', value: 'Fenrir' },
  { label: 'Calm', value: 'Charon' },
  { label: 'Friendly', value: 'Zephyr' },
];

const App: React.FC = () => {
  // Global State
  const [user, setUser] = useState<User | null>(null);
  const [currentView, setCurrentView] = useState<'auth' | 'desk'>('auth');
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentBooking, setCurrentBooking] = useState<BookingDetails>({});
  const [finalizedBooking, setFinalizedBooking] = useState<BookingDetails | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>('Kore');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isBookingsOpen, setIsBookingsOpen] = useState(false);
  
  // Refs for audio and connection management
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  // Fix: Added nextStartTimeRef to track audio playback queue for smooth playback as per guidelines
  const nextStartTimeRef = useRef<number>(0);
  // Fix: Added activeSourcesRef to track and stop audio buffers on interruption
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  // Fix: Added streamRef to manage microphone stream cleanup
  const streamRef = useRef<MediaStream | null>(null);
  // Fix: Ref to handle isMuted within scriptProcessor closures
  const isMutedRef = useRef(isMuted);

  // Fix: Keep ref in sync with state for concurrent access in audio processor
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // --- Utilities ---
  const addToast = (type: 'success' | 'error' | 'info', message: string) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  const addLog = (role: 'user' | 'ai' | 'system', message: string) => 
    setLogs(prev => [...prev, { timestamp: new Date(), role, message }]);

  // --- Auth ---
  const handleLogin = (u: User) => {
    setUser(u);
    setCurrentView('desk');
    addToast('success', `Welcome back, ${u.name}`);
  };

  const handleLogout = () => {
    setUser(null);
    setCurrentView('auth');
    setLogs([]);
    addToast('info', 'Signed out successfully');
    stopAudio();
  };

  // --- Audio Cleanup ---
  const stopAudio = useCallback(() => {
    // Fix: Clean up microphone tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;
    // Fix: Stop all scheduled audio buffers
    activeSourcesRef.current.forEach(s => s.stop());
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setAudioLevel(0);
  }, []);

  // --- Gemini Connection ---
  const connectToGemini = async () => {
    // Fix: Obtained API key exclusively from process.env.API_KEY as per guidelines
    setConnectionState(ConnectionState.CONNECTING);
    addLog('system', 'Initializing Omni Voice Gateway...');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `You are Omni, a luxury hotel concierge. Your user is ${user?.name}. Always calculate prices before finalization. Rates: Standard($150), Double($180), Deluxe($250).`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          // Fix: Use Modality.AUDIO enum for responseModalities
          responseModalities: [Modality.AUDIO],
          systemInstruction: prompt,
          tools: [{ functionDeclarations: [checkAvailabilityTool, finalizeBookingTool, cancelBookingTool] }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } }
        },
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            addLog('system', 'Connection Secure. Agent Online.');
            addToast('success', 'Concierge Connected');

            // Fix: Implemented microphone streaming logic within onopen callback
            navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
              streamRef.current = stream;
              if (!inputAudioContextRef.current) {
                inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
              }
              const ctx = inputAudioContextRef.current;
              const source = ctx.createMediaStreamSource(stream);
              const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
              
              scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                
                // Audio level visualization logic
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                setAudioLevel(Math.sqrt(sum / inputData.length));

                if (!isMutedRef.current) {
                  const pcmBlob = createPcmBlob(inputData);
                  // Fix: Solely rely on sessionPromise resolution before sending input to prevent race conditions
                  sessionPromise.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                  });
                }
              };
              
              source.connect(scriptProcessor);
              scriptProcessor.connect(ctx.destination);
            }).catch(err => {
              addToast('error', 'Microphone Access Denied');
              setConnectionState(ConnectionState.ERROR);
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            // Fix: Handle interruption from model by stopping all active sources
            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(source => source.stop());
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Fix: Implemented gapless audio playback scheduling using nextStartTimeRef
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              if (!outputAudioContextRef.current) {
                outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
              }
              const ctx = outputAudioContextRef.current;
              const audioBuffer = await decodeAudioData(base64ToArrayBuffer(base64Audio), ctx);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);

              // Correctly schedule each new chunk to start exactly after the previous one
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;

              activeSourcesRef.current.add(source);
              source.onended = () => activeSourcesRef.current.delete(source);
            }

            // Fix: Handle function calls with updated sendToolResponse implementation
            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                let result: any = {};
                if (call.name === 'check_availability') {
                  const args = call.args as any;
                  const financials = calculateStayCost(args.check_in_date, args.check_out_date, args.room_type);
                  setCurrentBooking({ ...args, total_cost: financials?.total });
                  result = { status: 'available', ...financials };
                } else if (call.name === 'finalize_booking') {
                  const code = 'OMNI-' + Math.random().toString(36).substring(7).toUpperCase();
                  const booking = { ...(call.args as any), email: user?.email, confirmation_code: code };
                  setFinalizedBooking(booking);
                  MockDatabase.saveBooking(booking);
                  result = { status: 'success', confirmation_code: code };
                }
                
                // Fix: Ensure Tool Response is sent after connection session is established
                sessionPromise.then((session) => {
                  session.sendToolResponse({
                    functionResponses: {
                      id: call.id,
                      name: call.name,
                      response: { result }
                    }
                  });
                });
              }
            }
          },
          onclose: () => {
            setConnectionState(ConnectionState.DISCONNECTED);
            stopAudio();
          },
          onerror: () => {
            setConnectionState(ConnectionState.ERROR);
            addToast('error', 'Agent Interrupted');
            stopAudio();
          }
        }
      });
      sessionRef.current = sessionPromise;
    } catch (e) {
      setConnectionState(ConnectionState.ERROR);
      addToast('error', 'Failed to initiate connection');
    }
  };

  if (currentView === 'auth') {
    return <AuthPage onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">
      {/* Dynamic Header */}
      <header className="sticky top-0 z-50 bg-slate-900/50 backdrop-blur-xl border-b border-slate-800 h-16 px-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-amber-500 rounded-lg flex items-center justify-center text-slate-900 font-bold brand-font">O</div>
          <span className="font-bold tracking-widest brand-font hidden sm:inline">OMNI</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-2 text-xs font-bold text-slate-400">
            <span className={`w-2 h-2 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
            {connectionState === ConnectionState.CONNECTED ? 'SECURE CHANNEL' : 'OFFLINE'}
          </div>
          <button onClick={handleLogout} className="text-slate-400 hover:text-white transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Reservation Desk Column */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-slate-900/50 rounded-3xl p-8 border border-slate-800 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/5 rounded-full blur-[100px] pointer-events-none" />
            
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold brand-font mb-2">Omni Concierge</h1>
              <p className="text-slate-500 text-sm">Welcome back, {user?.name}. How may I elevate your stay?</p>
            </div>

            <div className="mb-8">
              <Waveform isActive={connectionState === ConnectionState.CONNECTED} level={audioLevel} />
            </div>

            <div className="flex flex-col items-center gap-6">
              <div className="flex flex-wrap justify-center gap-2">
                {VOICE_OPTIONS.map(v => (
                  <button 
                    key={v.value}
                    onClick={() => setSelectedVoice(v.value)}
                    disabled={connectionState !== ConnectionState.DISCONNECTED}
                    className={`px-4 py-2 rounded-full text-[10px] font-bold tracking-widest uppercase transition-all border ${selectedVoice === v.value ? 'bg-amber-500 text-slate-900 border-amber-500' : 'bg-slate-800 text-slate-500 border-slate-700 hover:text-slate-300'}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>

              {connectionState === ConnectionState.DISCONNECTED ? (
                <button 
                  onClick={connectToGemini}
                  className="bg-amber-500 text-slate-900 px-12 py-4 rounded-full font-bold tracking-widest uppercase hover:bg-amber-400 transition-all shadow-xl shadow-amber-500/20 flex items-center gap-3"
                >
                  <Phone className="w-5 h-5" />
                  Begin Consultation
                </button>
              ) : (
                <div className="flex items-center gap-4">
                  <button onClick={() => setIsMuted(!isMuted)} className={`p-4 rounded-full border transition-all ${isMuted ? 'bg-red-500 border-red-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                    <Sparkles className="w-6 h-6" />
                  </button>
                  <button onClick={() => { sessionRef.current?.then((s: any) => s.close()); stopAudio(); setConnectionState(ConnectionState.DISCONNECTED); }} className="bg-red-600 text-white px-8 py-4 rounded-full font-bold uppercase tracking-widest hover:bg-red-500 transition-all">
                    End Call
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="bg-slate-900 rounded-2xl border border-slate-800 h-64 flex flex-col">
            <div className="px-4 py-3 border-b border-slate-800 text-[10px] font-bold text-slate-500 uppercase tracking-widest flex justify-between">
              <span>Encrypted Transaction Logs</span>
              <div className="flex gap-1"><div className="w-1.5 h-1.5 rounded-full bg-slate-800" /><div className="w-1.5 h-1.5 rounded-full bg-slate-800" /></div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[11px] custom-scrollbar">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-4">
                  <span className="text-slate-700 shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                  <span className={`${log.role === 'ai' ? 'text-amber-500' : 'text-slate-400'}`}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar Status Column */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-slate-900 rounded-3xl p-6 border border-slate-800 shadow-xl">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-500" />
              Live Consultation
            </h3>
            <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-4">
              <div className="flex justify-between items-end border-b border-slate-800 pb-3">
                <span className="text-slate-600 text-xs">Room Choice</span>
                <span className="text-white font-bold">{currentBooking.room_type || '---'}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-[10px] text-slate-600 uppercase font-bold block">Check In</span>
                  <span className="text-slate-300 text-sm">{currentBooking.check_in_date || '--'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-600 uppercase font-bold block">Check Out</span>
                  <span className="text-slate-300 text-sm">{currentBooking.check_out_date || '--'}</span>
                </div>
              </div>
              <div className="pt-3 border-t border-slate-800 flex justify-between">
                <span className="text-slate-600 text-xs">Estimated Total</span>
                <span className="text-amber-500 font-bold">${currentBooking.total_cost || '0.00'}</span>
              </div>
            </div>
          </div>

          {finalizedBooking && (
            <div className="bg-amber-500 rounded-3xl p-[2px] shadow-2xl animate-in slide-in-from-right duration-500">
              <div className="bg-slate-900 rounded-[calc(1.5rem-2px)] p-6">
                <div className="flex items-center gap-3 mb-4">
                  <ShieldCheck className="w-6 h-6 text-amber-500" />
                  <h2 className="font-bold text-white brand-font">Reserved</h2>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Conf. Code</span>
                    <span className="font-mono text-amber-500 font-bold">{finalizedBooking.confirmation_code}</span>
                  </div>
                  <p className="text-[10px] text-slate-500 italic text-center">Confirmation email dispatched to your account.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <BackToTop />
      
      {/* Toast Overlay */}
      <div className="fixed top-20 right-6 z-[200] space-y-4">
        {toasts.map(t => (
          <div key={t.id} className="bg-slate-900/90 border border-slate-700 backdrop-blur-md px-4 py-3 rounded-xl shadow-2xl animate-in slide-in-from-right flex items-center gap-3">
             <div className={`w-2 h-2 rounded-full ${t.type === 'success' ? 'bg-green-500' : 'bg-amber-500'}`} />
             <span className="text-xs font-medium text-white">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default App;

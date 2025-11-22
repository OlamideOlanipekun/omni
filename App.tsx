import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { BookingDetails, ConnectionState, LogEntry, User, Toast } from './types';
import { createPcmBlob, decodeAudioData, base64ToArrayBuffer } from './utils/audioUtils';
import Waveform from './components/Waveform';

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
    
    // Fuzzy match room type to rate
    const key = Object.keys(ROOM_RATES).find(r => roomType.toLowerCase().includes(r)) || 'standard';
    const rate = ROOM_RATES[key];
    
    return {
      nights: nights || 1, // Min 1 night
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
        console.log(`[Mock Email Service] Email sent to ${email} for booking ${booking.confirmation_code}`);
        resolve(true);
      }, 2000);
    });
  }
};

// --- System Prompt & Tool Definitions ---

const BASE_SYSTEM_PROMPT = `
ROLE
You are “Omni”, a professional, warm, and efficient hotel booking specialist.
Your goal is to secure bookings, upsell suites when appropriate, and provide a seamless voice experience.

CONTEXT
User: {{USER_NAME}} ({{USER_EMAIL}})
Current Date: ${new Date().toLocaleDateString()}

💰 PRICING RULES
- You MUST quote the price per night and the TOTAL cost before finalizing.
- Rates: Standard ($150), Double ($180), Deluxe ($250), Family ($300), Suite ($450).
- If the user asks for a room, use the 'check_availability' tool to get the calculated total price.

🔧 CALL FLOW
1. **Greeting**: "Hello {{USER_NAME}}, thank you for calling Omni Reservations. How may I assist you with your stay?"
2. **Discovery**: Ask for Check-in, Check-out, Guests, and Room Preference.
3. **Availability & Quote**: 
   - Call 'check_availability' with the details.
   - The tool will return the Price Per Night and Total Cost.
   - Say: "I have a {room} available. It is {rate} per night, bringing the total for {nights} nights to {total}. Does that sound good?"
4. **Details**: Collect Phone Number and Special Requests.
5. **Final Confirmation**: "Just to confirm: {Room} from {Start} to {End} for {Total Price}. Shall I book this now?"
6. **Finalize**: Call 'finalize_booking'. Then say: "You are all set! Confirmation sent to your email."

⚠️ CRITICAL INSTRUCTIONS
- Always use the tool 'check_availability' immediately after receiving dates and room type to get the price.
- Do not make up prices. Use the tool output.
- If the user cancels, be helpful and confirm using 'cancel_booking'.
`;

const checkAvailabilityTool: FunctionDeclaration = {
  name: 'check_availability',
  description: 'Checks availability and CALCULATES PRICE based on dates. usage: Call this when you have dates and room type.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      room_type: { type: Type.STRING },
      check_in_date: { type: Type.STRING, description: "YYYY-MM-DD" },
      check_out_date: { type: Type.STRING, description: "YYYY-MM-DD" },
      guests: { type: Type.STRING },
      name: { type: Type.STRING },
      special_requests: { type: Type.STRING },
    },
    required: ['room_type', 'check_in_date', 'check_out_date'],
  },
};

const finalizeBookingTool: FunctionDeclaration = {
  name: 'finalize_booking',
  description: 'Finalizes the booking after user accepts the price.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING },
      phone: { type: Type.STRING },
      room_type: { type: Type.STRING },
      check_in_date: { type: Type.STRING },
      check_out_date: { type: Type.STRING },
      guests: { type: Type.STRING },
      branch: { type: Type.STRING },
      special_requests: { type: Type.STRING },
      total_cost: { type: Type.NUMBER },
    },
    required: ['name', 'phone', 'room_type', 'check_in_date', 'check_out_date'],
  },
};

const listBookingsTool: FunctionDeclaration = {
  name: 'list_bookings',
  description: 'Retrieves existing bookings. Use for cancellations or status checks.',
  parameters: { type: Type.OBJECT, properties: {} }, 
};

const cancelBookingTool: FunctionDeclaration = {
  name: 'cancel_booking',
  description: 'Cancels a booking using its confirmation code.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      confirmation_code: { type: Type.STRING },
    },
    required: ['confirmation_code'],
  },
};

const VOICE_OPTIONS = [
  { label: 'Standard', value: 'Puck' },
  { label: 'Professional', value: 'Kore' },
  { label: 'Warm', value: 'Fenrir' },
  { label: 'Calm', value: 'Charon' },
  { label: 'Friendly', value: 'Zephyr' },
];

// --- UI Components ---

const ToastContainer: React.FC<{ toasts: Toast[], removeToast: (id: string) => void }> = ({ toasts, removeToast }) => {
  return (
    <div className="fixed top-20 right-4 z-[150] flex flex-col gap-3 pointer-events-none">
      {toasts.map((toast) => (
        <div 
          key={toast.id} 
          className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl border backdrop-blur-md animate-slide-in transition-all w-80 ${
            toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/50 text-emerald-100' :
            toast.type === 'error' ? 'bg-red-900/80 border-red-500/50 text-red-100' :
            'bg-slate-800/90 border-slate-600 text-slate-100'
          }`}
        >
          {toast.type === 'success' && <svg className="w-5 h-5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
          {toast.type === 'error' && <svg className="w-5 h-5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          {toast.type === 'info' && <svg className="w-5 h-5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          <p className="text-sm font-medium">{toast.message}</p>
          <button onClick={() => removeToast(toast.id)} className="ml-auto text-white/50 hover:text-white"><svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg></button>
        </div>
      ))}
    </div>
  );
};

const LoginModal: React.FC<{ isOpen: boolean; onClose: () => void; onLogin: (u: User) => void }> = ({ isOpen, onClose, onLogin }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name && email) {
      onLogin({ id: crypto.randomUUID(), name, email });
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 p-8 rounded-2xl border border-slate-700 shadow-2xl w-full max-w-md relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-500 hover:text-white">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-gradient-to-br from-amber-400 to-amber-600 rounded-xl flex items-center justify-center text-slate-900 font-bold brand-font text-xl mx-auto mb-4">O</div>
          <h2 className="text-2xl font-bold text-white brand-font">Welcome to Omni</h2>
          <p className="text-slate-400 text-sm mt-2">Sign in to access your reservations.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Full Name</label>
            <input 
              type="text" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
              placeholder="e.g. John Doe"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Email Address</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
              placeholder="john@example.com"
              required
            />
          </div>
          <button 
            type="submit" 
            className="w-full bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold py-3.5 rounded-lg transition-all duration-200 shadow-lg shadow-amber-500/20 mt-2"
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
};

const BookingsDrawer: React.FC<{ 
  isOpen: boolean; 
  onClose: () => void; 
  bookings: BookingDetails[]; 
  onCancel: (code: string) => void; 
}> = ({ isOpen, onClose, bookings, onCancel }) => {
  const [activeTab, setActiveTab] = useState<'upcoming' | 'history'>('upcoming');

  if (!isOpen) return null;

  const upcoming = bookings.filter(b => b.status === 'confirmed' || b.status === 'pending');
  const history = bookings.filter(b => b.status === 'cancelled');

  const displayList = activeTab === 'upcoming' ? upcoming : history;

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-md flex pointer-events-none">
        <div className="w-full h-full bg-slate-900 border-l border-slate-800 shadow-2xl pointer-events-auto flex flex-col animate-slide-in-right">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800 bg-slate-900/50">
            <div>
                <h2 className="text-xl font-bold text-white brand-font">My Reservations</h2>
                <p className="text-xs text-slate-500">Manage your bookings and history</p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors p-2 hover:bg-slate-800 rounded-full">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {/* Tabs */}
          <div className="flex border-b border-slate-800 bg-slate-900/50">
            <button 
              onClick={() => setActiveTab('upcoming')}
              className={`flex-1 py-4 text-sm font-bold uppercase tracking-wide border-b-2 transition-all ${activeTab === 'upcoming' ? 'border-amber-500 text-amber-500 bg-amber-900/10' : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'}`}
            >
              Upcoming ({upcoming.length})
            </button>
            <button 
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-4 text-sm font-bold uppercase tracking-wide border-b-2 transition-all ${activeTab === 'history' ? 'border-amber-500 text-amber-500 bg-amber-900/10' : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'}`}
            >
              History ({history.length})
            </button>
          </div>
          {/* List */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar bg-slate-950/30">
            {displayList.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6">
                <div className="w-20 h-20 bg-slate-800/50 rounded-full flex items-center justify-center mb-6 border border-slate-700">
                  <svg className="w-10 h-10 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">No {activeTab} reservations</h3>
                <p className="text-slate-500 text-sm max-w-xs">
                  {activeTab === 'upcoming' 
                    ? "You don't have any upcoming stays. Start a conversation with Omni to book your next trip!" 
                    : "Your past and cancelled reservations will appear here."}
                </p>
              </div>
            ) : (
              displayList.map((booking, i) => (
                <div key={i} className={`group bg-slate-800/40 border rounded-xl p-5 transition-all duration-200 hover:bg-slate-800/60 ${booking.status === 'cancelled' ? 'border-slate-800 opacity-75' : 'border-slate-700 shadow-sm hover:border-amber-500/30'}`}>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                         <h3 className={`text-lg font-bold ${booking.status === 'cancelled' ? 'text-slate-500 line-through' : 'text-white group-hover:text-amber-100'}`}>{booking.room_type}</h3>
                      </div>
                      <div className="flex items-center gap-2">
                          {booking.status === 'confirmed' && <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-green-900/30 text-green-400 border border-green-900/50 uppercase tracking-wider">Confirmed</span>}
                          {booking.status === 'cancelled' && <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-900/30 text-red-400 border border-red-900/50 uppercase tracking-wider">Cancelled</span>}
                          <span className="text-slate-500 text-xs">• {booking.branch || 'Main Branch'}</span>
                      </div>
                    </div>
                    <div className="text-right">
                        <p className="text-lg font-bold text-white">{booking.total_cost ? `$${booking.total_cost}` : 'TBD'}</p>
                        <p className="text-[10px] text-slate-500 uppercase">Total</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm mb-5 bg-slate-900/30 p-3 rounded-lg border border-slate-800/50">
                    <div><p className="text-[10px] text-slate-500 uppercase font-bold">Check In</p><p className="text-slate-200 font-medium mt-0.5">{booking.check_in_date}</p></div>
                    <div><p className="text-[10px] text-slate-500 uppercase font-bold">Check Out</p><p className="text-slate-200 font-medium mt-0.5">{booking.check_out_date}</p></div>
                    <div><p className="text-[10px] text-slate-500 uppercase font-bold">Guests</p><p className="text-slate-200 font-medium mt-0.5">{booking.guests} Guests</p></div>
                    <div><p className="text-[10px] text-slate-500 uppercase font-bold">Ref Code</p><p className="text-amber-400 font-mono font-medium mt-0.5">{booking.confirmation_code}</p></div>
                  </div>
                  {activeTab === 'upcoming' && booking.status === 'confirmed' && (
                    <div className="border-t border-slate-700/50 pt-4 flex justify-end">
                      <button 
                        onClick={() => {
                          if(window.confirm("Are you sure you want to cancel this reservation?")) {
                            onCancel(booking.confirmation_code || "");
                          }
                        }}
                        className="text-xs font-bold text-red-400 hover:text-red-300 hover:bg-red-900/20 px-4 py-2 rounded-lg transition-colors flex items-center gap-2 border border-transparent hover:border-red-900/30"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        Cancel Reservation
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Main Component ---

const App: React.FC = () => {
  // State
  const [user, setUser] = useState<User | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isBookingsOpen, setIsBookingsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentBooking, setCurrentBooking] = useState<BookingDetails>({});
  const [finalizedBooking, setFinalizedBooking] = useState<BookingDetails | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>('Kore');
  const [isScrolled, setIsScrolled] = useState<boolean>(false);
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  
  // Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);

  // --- Utilities ---
  const addToast = (type: 'success' | 'error' | 'info', message: string) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };
  const removeToast = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 10);
    window.addEventListener('scroll', handleScroll);
    const storedUser = localStorage.getItem('omni_user');
    if (storedUser) setUser(JSON.parse(storedUser));
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // --- Auth Handlers ---
  const handleLogin = (u: User) => {
    setUser(u);
    localStorage.setItem('omni_user', JSON.stringify(u));
    addToast('success', `Welcome back, ${u.name}!`);
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('omni_user');
    setFinalizedBooking(null);
    setCurrentBooking({});
    setLogs([]);
    setIsMobileMenuOpen(false);
    addToast('info', 'Logged out successfully.');
  };

  const refreshData = () => setRefreshTrigger(prev => prev + 1);

  // --- Audio Management ---
  const stopAudio = useCallback(() => {
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (inputSourceRef.current) { inputSourceRef.current.disconnect(); inputSourceRef.current = null; }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach(track => track.stop()); mediaStreamRef.current = null; }
    scheduledSourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    scheduledSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setAudioLevel(0);
    setIsMuted(false);
  }, []);

  const startAudio = useCallback(async (sessionPromise: Promise<any>) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioContextRef.current = inputCtx;
      
      // Ensure context is running
      if (inputCtx.state === 'suspended') {
        await inputCtx.resume();
      }

      const source = inputCtx.createMediaStreamSource(stream);
      inputSourceRef.current = source;
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        setAudioLevel(prev => prev * 0.8 + (mediaStreamRef.current && mediaStreamRef.current.getAudioTracks().some(t => t.enabled) ? rms : 0) * 2.0);
        
        // Prevent sending if context is closed or session is gone
        if (inputCtx.state === 'closed') return;

        const pcmBlob = createPcmBlob(inputData);
        sessionPromise.then(session => {
             try {
                session.sendRealtimeInput({ media: pcmBlob });
             } catch (e) {
                // Ignored: session might be closing
             }
        });
      };
      source.connect(processor);
      processor.connect(inputCtx.destination);
      
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioContextRef.current = outputCtx;
       if (outputCtx.state === 'suspended') {
        await outputCtx.resume();
      }
    } catch (error) {
      console.error("Audio initialization error:", error);
      setConnectionState(ConnectionState.ERROR);
      addToast('error', 'Could not access microphone. Please check permissions.');
      addLog('system', 'Failed to initialize audio devices.');
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (mediaStreamRef.current) {
      const newState = !isMuted;
      mediaStreamRef.current.getAudioTracks().forEach(track => track.enabled = !newState);
      setIsMuted(newState);
    }
  }, [isMuted]);

  // --- Gemini Interaction ---
  const addLog = (role: 'user' | 'ai' | 'system', message: string) => setLogs(prev => [...prev, { timestamp: new Date(), role, message }]);

  const connectToGemini = async () => {
    if (!user) { setIsLoginOpen(true); return; }
    if (!process.env.API_KEY) { addToast('error', 'API Key missing'); return; }

    setConnectionState(ConnectionState.CONNECTING);
    setFinalizedBooking(null);
    setCurrentBooking({});
    setEmailStatus('idle');
    addLog('system', `Establishing connection for ${user.name}...`);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const personalizedPrompt = BASE_SYSTEM_PROMPT.replace(/{{USER_NAME}}/g, user.name).replace(/{{USER_EMAIL}}/g, user.email);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: ['AUDIO'], // Using string literal to avoid enum issues
          systemInstruction: personalizedPrompt,
          tools: [{ functionDeclarations: [checkAvailabilityTool, finalizeBookingTool, listBookingsTool, cancelBookingTool] }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } }
        },
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            addLog('system', 'Connected. Agent online.');
            addToast('success', 'Connected to Omni Voice Agent');
            startAudio(sessionPromise);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              const audioBuffer = await decodeAudioData(base64ToArrayBuffer(base64Audio), ctx, 24000);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              scheduledSourcesRef.current.add(source);
              source.onended = () => scheduledSourcesRef.current.delete(source);
              nextStartTimeRef.current += audioBuffer.duration;
            }

            if (message.toolCall) {
              const responses = [];
              for (const call of message.toolCall.functionCalls) {
                addLog('system', `Tool: ${call.name}`);
                let result: any = {};
                
                if (call.name === 'check_availability') {
                   const args = call.args as any;
                   // Calculate Financials
                   const financials = calculateStayCost(args.check_in_date, args.check_out_date, args.room_type);
                   const enrichedDetails = { ...args, 
                      price_per_night: financials?.rate || 0, 
                      total_cost: financials?.total || 0,
                      total_nights: financials?.nights || 0
                   };
                   setCurrentBooking(prev => ({ ...prev, ...enrichedDetails }));
                   result = financials 
                     ? { status: 'available', ...financials, currency: 'USD' } 
                     : { status: 'unavailable', message: 'Invalid dates or room type.' };
                   addLog('system', financials ? `Quoting $${financials.total}` : 'Availability check failed.');

                } else if (call.name === 'finalize_booking') {
                   const bookingData = call.args as BookingDetails;
                   const confCode = 'OMNI-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
                   const completeBooking = { ...bookingData, email: user.email, confirmation_code: confCode };
                   
                   setCurrentBooking(completeBooking);
                   setFinalizedBooking(completeBooking);
                   MockDatabase.saveBooking(completeBooking);
                   refreshData();
                   setEmailStatus('sending');
                   addToast('success', 'Booking confirmed!');
                   MockDatabase.sendConfirmationEmail(user.email, completeBooking).then(() => {
                     setEmailStatus('sent');
                     addToast('info', 'Confirmation email sent.');
                   });
                   result = { confirmation_code: confCode };

                } else if (call.name === 'list_bookings') {
                   const activeBookings = MockDatabase.getBookings(user.email).filter((b:BookingDetails) => b.status === 'confirmed');
                   result = activeBookings;
                   addLog('system', `Found ${activeBookings.length} active bookings.`);

                } else if (call.name === 'cancel_booking') {
                   const { confirmation_code } = call.args as any;
                   const success = MockDatabase.cancelBooking(confirmation_code);
                   if (success) {
                     refreshData();
                     addToast('success', 'Reservation cancelled.');
                     result = { status: "success", message: "Booking cancelled" };
                   } else {
                     result = { status: "error", message: "Booking not found" };
                   }
                }
                responses.push({ id: call.id, name: call.name, response: { result } });
              }
              sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
            }
          },
          onclose: () => {
            setConnectionState(ConnectionState.DISCONNECTED);
            addLog('system', 'Call ended.');
            stopAudio();
          },
          onerror: (err) => {
            console.error(err);
            setConnectionState(ConnectionState.ERROR);
            addToast('error', 'Connection error. Verify API Key or Network.');
            addLog('system', 'Network or API Error occurred.');
            stopAudio();
          }
        }
      });
      sessionRef.current = sessionPromise;
    } catch (e) {
      console.error(e);
      setConnectionState(ConnectionState.ERROR);
      addToast('error', 'Failed to connect.');
      stopAudio();
    }
  };

  const endCall = () => {
    if (sessionRef.current) {
        stopAudio();
        setConnectionState(ConnectionState.DISCONNECTED);
        addLog('system', 'Disconnected by user.');
        sessionRef.current = null;
    }
  };

  useEffect(() => { return () => stopAudio(); }, [stopAudio]);

  // --- Derived State ---
  const userBookings = user ? MockDatabase.getBookings(user.email) : [];
  const activeBookingsCount = userBookings.filter((b: BookingDetails) => b.status === 'confirmed').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30 flex flex-col">
      <ToastContainer toasts={toasts} removeToast={removeToast} />
      <LoginModal isOpen={isLoginOpen} onClose={() => setIsLoginOpen(false)} onLogin={handleLogin} />
      <BookingsDrawer isOpen={isBookingsOpen} onClose={() => setIsBookingsOpen(false)} bookings={userBookings} onCancel={(code) => {
          if(MockDatabase.cancelBooking(code)) { refreshData(); addToast('success', 'Booking cancelled manually'); }
        }} 
      />
      
      {/* Header */}
      <header className={`sticky top-0 z-50 transition-all duration-500 border-b ${isScrolled ? (connectionState === ConnectionState.CONNECTED ? 'bg-slate-900/90 backdrop-blur-xl border-amber-500/20 shadow-lg shadow-amber-900/10' : 'bg-slate-900/80 backdrop-blur-md border-slate-800 shadow-md') : 'bg-transparent border-transparent backdrop-blur-none'}`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => window.location.reload()}>
            <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-lg flex items-center justify-center text-slate-900 font-bold brand-font text-lg">O</div>
            <span className="text-xl font-bold text-white brand-font tracking-wider">OMNI</span>
          </div>
          <div className="flex items-center gap-6">
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
               {user ? (
                  <>
                    <button onClick={() => setIsBookingsOpen(true)} className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-all ${activeBookingsCount > 0 ? 'bg-amber-900/20 text-amber-400 hover:bg-amber-900/30' : 'hover:text-white'}`}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                      My Bookings
                      {activeBookingsCount > 0 && <span className="ml-1 flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-slate-900 text-xs font-bold">{activeBookingsCount}</span>}
                    </button>
                    <div className="w-px h-4 bg-slate-700"></div>
                    <span className="text-slate-200 cursor-default">Hi, {user.name.split(' ')[0]}</span>
                    <button onClick={handleLogout} className="text-slate-500 hover:text-white transition-colors">Logout</button>
                  </>
               ) : (
                  <button onClick={() => setIsLoginOpen(true)} className="hover:text-amber-400 transition-colors font-bold">Login</button>
               )}
            </nav>
             <div className={`hidden sm:flex items-center px-3 py-1 rounded-full text-xs font-bold border ${connectionState === ConnectionState.CONNECTED ? 'bg-green-900/20 border-green-800 text-green-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                <span className={`w-2 h-2 rounded-full mr-2 ${connectionState === ConnectionState.CONNECTED ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`}></span>
                {connectionState === ConnectionState.CONNECTED ? 'AGENT ONLINE' : 'AGENT OFFLINE'}
             </div>
             <button className="md:hidden p-2 text-slate-400 hover:text-white" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">{isMobileMenuOpen ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />}</svg>
             </button>
          </div>
        </div>
        {/* Mobile Menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-slate-800 bg-slate-900/95 backdrop-blur-xl animate-fade-in">
            <div className="px-4 pt-2 pb-6 space-y-1">
              {user ? (
                <>
                  <div className="py-3 px-3 text-slate-500 text-xs font-bold uppercase tracking-widest">User Menu</div>
                  <button onClick={() => { setIsBookingsOpen(true); setIsMobileMenuOpen(false); }} className="flex items-center justify-between w-full text-left px-3 py-3 text-base font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-md">
                    <span>My Bookings</span>
                    {activeBookingsCount > 0 && <span className="bg-amber-500 text-slate-900 text-xs font-bold px-2 py-0.5 rounded-full">{activeBookingsCount}</span>}
                  </button>
                  <button onClick={() => { handleLogout(); setIsMobileMenuOpen(false); }} className="block w-full text-left px-3 py-3 text-base font-medium text-red-400 hover:text-red-300 hover:bg-slate-800 rounded-md">Sign Out ({user.name})</button>
                </>
              ) : (
                <button onClick={() => { setIsLoginOpen(true); setIsMobileMenuOpen(false); }} className="block w-full text-left px-3 py-3 text-base font-medium text-amber-400 hover:bg-slate-800 rounded-md">Sign In</button>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-6">
            <div className="bg-slate-900 rounded-2xl p-6 sm:p-8 shadow-2xl border border-slate-800 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/5 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none"></div>
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl -ml-16 -mb-16 pointer-events-none"></div>
              <div className="relative z-10">
                <div className="text-center mb-8">
                  <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2 brand-font">Reservations Desk</h1>
                  <p className="text-slate-400">{user ? `Welcome back, ${user.name}. Speak naturally to book.` : "Please sign in to start booking."}</p>
                </div>
                <div className="w-full flex justify-center mb-6 h-32 sm:h-40 bg-slate-950/50 rounded-xl border border-slate-800 shadow-inner relative items-center">
                   {connectionState !== ConnectionState.CONNECTED && <div className="absolute text-slate-600 text-sm animate-pulse">{user ? "Ready to connect..." : "Waiting for login..."}</div>}
                   {connectionState === ConnectionState.CONNECTED && isMuted && <div className="absolute z-20 flex items-center gap-2 bg-slate-900/80 px-4 py-2 rounded-full border border-red-500/30 text-red-400 text-sm font-bold backdrop-blur-sm animate-pulse">MUTED</div>}
                  <Waveform isActive={connectionState === ConnectionState.CONNECTED} level={audioLevel} />
                </div>
                <div className="flex flex-col items-center justify-center mb-6">
                  <label className="text-xs text-slate-500 uppercase font-bold mb-2 tracking-wider">Select Agent Voice</label>
                  <div className="flex flex-wrap justify-center gap-2">
                    {VOICE_OPTIONS.map((opt) => (
                      <button key={opt.value} onClick={() => setSelectedVoice(opt.value)} disabled={connectionState !== ConnectionState.DISCONNECTED} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border ${selectedVoice === opt.value ? 'bg-amber-500 text-slate-900 border-amber-500 shadow-lg shadow-amber-500/20' : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600 hover:text-slate-200'} ${connectionState !== ConnectionState.DISCONNECTED ? 'opacity-50 cursor-not-allowed' : ''}`}>{opt.label}</button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-center gap-4">
                  {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
                    !user ? (
                       <button onClick={() => setIsLoginOpen(true)} className="group relative inline-flex items-center justify-center px-8 py-4 text-base font-bold text-slate-900 transition-all duration-200 bg-amber-500 rounded-full hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/20">Sign In to Start</button>
                    ) : (
                    <button onClick={connectToGemini} className="group relative inline-flex items-center justify-center px-8 py-4 text-base font-bold text-white transition-all duration-200 bg-gradient-to-r from-amber-600 to-amber-700 rounded-full hover:from-amber-500 hover:to-amber-600 hover:shadow-lg hover:shadow-amber-600/20">
                      <svg className="w-6 h-6 mr-2 -ml-1 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg> Start Voice Call
                    </button>
                    )
                  ) : (
                    <div className="flex items-center gap-4">
                        <button onClick={toggleMute} className={`group relative inline-flex items-center justify-center px-6 py-4 text-base font-bold transition-all duration-200 rounded-full ${isMuted ? 'bg-amber-500 text-slate-900 hover:bg-amber-400' : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700'}`}>{isMuted ? 'Unmute' : 'Mute'}</button>
                        <button onClick={endCall} className="group relative inline-flex items-center justify-center px-6 py-4 text-base font-bold text-white transition-all duration-200 bg-red-600 rounded-full hover:bg-red-500">End Call</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden flex flex-col h-[300px]">
              <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Live Conversation Logs</h3>
                <div className="flex gap-1"><div className="w-2 h-2 rounded-full bg-red-500"></div><div className="w-2 h-2 rounded-full bg-yellow-500"></div><div className="w-2 h-2 rounded-full bg-green-500"></div></div>
              </div>
              <div className="p-4 overflow-y-auto flex-grow font-mono text-xs space-y-2 custom-scrollbar bg-slate-950">
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-3 animate-fade-in border-b border-slate-900/50 pb-1 last:border-0">
                    <span className="text-slate-600 shrink-0 w-14 text-[10px] pt-0.5">{log.timestamp.toLocaleTimeString([], {hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
                    <div className="flex-1">
                       <span className={`uppercase font-bold text-[10px] mr-2 px-1 rounded ${log.role === 'system' ? 'bg-blue-900/30 text-blue-400' : log.role === 'ai' ? 'bg-amber-900/30 text-amber-400' : 'bg-green-900/30 text-green-400'}`}>{log.role}</span>
                       <span className="text-slate-300">{log.message}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* Right Column: Live Data */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-6">
            {finalizedBooking && (
               <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-[2px] shadow-xl animate-fade-in-up">
                <div className="bg-slate-900 rounded-2xl p-6 h-full relative overflow-hidden">
                  <div className="absolute -right-10 -top-10 w-40 h-40 bg-emerald-500/20 rounded-full blur-3xl pointer-events-none"></div>
                  <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="p-2 bg-emerald-500/20 rounded-lg text-emerald-400">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-white">Booking Confirmed</h2>
                        <p className="text-xs text-emerald-400 font-medium">Reservation successful</p>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div className="bg-slate-950/50 rounded-xl p-4 border border-slate-800">
                        <div className="flex justify-between items-end mb-2">
                          <span className="text-2xl font-bold text-white">{finalizedBooking.room_type || 'Room'}</span>
                          <span className="text-emerald-400 font-mono text-lg">{finalizedBooking.confirmation_code}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <div><span className="text-slate-500 text-xs uppercase block">Check In</span><span className="text-slate-300">{finalizedBooking.check_in_date}</span></div>
                          <div><span className="text-slate-500 text-xs uppercase block">Check Out</span><span className="text-slate-300">{finalizedBooking.check_out_date}</span></div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-slate-400 bg-slate-800/30 p-3 rounded-lg border border-slate-800">
                         {emailStatus === 'sending' ? (
                            <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Sending confirmation email...</>
                         ) : emailStatus === 'sent' ? (
                            <><svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg> Email sent to {user?.email}</>
                         ) : null}
                      </div>
                    </div>
                  </div>
                </div>
               </div>
            )}
            
            <div className="bg-slate-900 rounded-2xl p-6 shadow-xl border border-slate-800">
               <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                 <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></span> Live Draft
               </h3>
               <div className="space-y-4">
                  <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
                     <div className="flex justify-between border-b border-slate-800 pb-2">
                       <span className="text-slate-500 text-sm">Room Type</span>
                       <span className="text-amber-400 font-medium">{currentBooking.room_type || '...'}</span>
                     </div>
                     <div className="grid grid-cols-2 gap-4">
                        <div><span className="block text-slate-500 text-xs">Check In</span><span className="text-slate-200 text-sm">{currentBooking.check_in_date || '--'}</span></div>
                        <div><span className="block text-slate-500 text-xs">Check Out</span><span className="text-slate-200 text-sm">{currentBooking.check_out_date || '--'}</span></div>
                     </div>
                     <div className="flex justify-between border-t border-slate-800 pt-2 mt-2">
                       <span className="text-slate-500 text-sm">Total Estimate</span>
                       <span className="text-white font-bold">{currentBooking.total_cost ? `$${currentBooking.total_cost}` : '---'}</span>
                     </div>
                  </div>
                  <div className="text-xs text-slate-500 text-center italic">
                     All details are verified by the agent before booking.
                  </div>
               </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
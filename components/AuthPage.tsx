import React, { useState } from 'react';
import { Mail, Lock, User, ArrowRight, Sparkles, ShieldCheck } from 'lucide-react';

interface AuthPageProps {
  onLogin: (user: { id: string; name: string; email: string }) => void;
}

const AuthPage: React.FC<AuthPageProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate luxury verification
    setTimeout(() => {
      onLogin({ id: crypto.randomUUID(), name: name || 'Valued Guest', email });
      setIsLoading(false);
    }, 1500);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div className="max-w-5xl w-full bg-slate-900 rounded-[2.5rem] overflow-hidden shadow-2xl flex flex-col md:flex-row min-h-[600px] border border-slate-800 animate-in fade-in zoom-in duration-700">
        
        {/* Visual Brand Side */}
        <div className="md:w-1/2 relative bg-slate-950 overflow-hidden hidden md:block">
          <img 
            src="https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&q=80&w=1000" 
            alt="Luxury Hotel" 
            className="absolute inset-0 w-full h-full object-cover opacity-40 scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 via-transparent to-slate-950" />
          <div className="absolute inset-0 p-12 flex flex-col justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center text-slate-900 font-bold brand-font text-xl">O</div>
              <span className="text-xl font-bold text-white brand-font tracking-widest">OMNI</span>
            </div>
            
            <div className="space-y-6">
              <h2 className="text-4xl font-serif text-white leading-tight">Your gateway to <br /><span className="text-amber-500 italic">extraordinary</span> stays.</h2>
              <div className="space-y-4">
                {[
                  "Priority Voice Support",
                  "Personalized Room Profiles",
                  "Exclusive Member Rates"
                ].map((perk, i) => (
                  <div key={i} className="flex items-center gap-3 text-slate-400 text-sm">
                    <ShieldCheck className="w-4 h-4 text-amber-500" />
                    <span>{perk}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Interaction Side */}
        <div className="flex-1 p-8 md:p-16 flex flex-col justify-center bg-slate-900">
          <div className="mb-10">
            <h1 className="text-3xl font-bold text-white brand-font mb-2">
              {isLogin ? 'Member Access' : 'Join the Circle'}
            </h1>
            <p className="text-slate-400 text-sm">
              {isLogin ? 'Welcome back to Omni. Please sign in.' : 'Experience the future of luxury hospitality.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {!isLogin && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Full Name</label>
                <div className="flex items-center bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 focus-within:border-amber-500/50 transition-all">
                  <User className="w-4 h-4 text-slate-500 mr-3" />
                  <input 
                    required 
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="bg-transparent outline-none text-white w-full text-sm font-light" 
                    placeholder="John Doe" 
                  />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Email Address</label>
              <div className="flex items-center bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 focus-within:border-amber-500/50 transition-all">
                <Mail className="w-4 h-4 text-slate-500 mr-3" />
                <input 
                  required 
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-transparent outline-none text-white w-full text-sm font-light" 
                  placeholder="name@example.com" 
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Password</label>
              <div className="flex items-center bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 focus-within:border-amber-500/50 transition-all">
                <Lock className="w-4 h-4 text-slate-500 mr-3" />
                <input 
                  required 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-transparent outline-none text-white w-full text-sm font-light" 
                  placeholder="••••••••" 
                />
              </div>
            </div>

            <button 
              type="submit" 
              disabled={isLoading}
              className="w-full bg-amber-500 text-slate-900 py-4 rounded-xl font-bold text-xs tracking-widest uppercase hover:bg-amber-400 transition-all shadow-xl shadow-amber-500/10 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <Sparkles className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <span>{isLogin ? 'Sign In' : 'Establish Account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center">
            <button 
              onClick={() => setIsLogin(!isLogin)}
              className="text-xs font-medium text-slate-500 hover:text-amber-500 transition-colors"
            >
              {isLogin ? "Don't have an account? Join Omni" : "Already a member? Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
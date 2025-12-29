import React, { useState, useEffect } from 'react';
import { ChevronUp } from 'lucide-react';

const BackToTop: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const toggleVisibility = () => {
      if (window.scrollY > 400) {
        setIsVisible(true);
      } else {
        setIsVisible(false);
      }
    };

    window.addEventListener('scroll', toggleVisibility);
    return () => window.removeEventListener('scroll', toggleVisibility);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  if (!isVisible) return null;

  return (
    <button
      onClick={scrollToTop}
      className="fixed bottom-8 right-8 z-[120] group animate-in fade-in slide-in-from-bottom-4 duration-500"
      aria-label="Back to top"
    >
      <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-700 text-amber-500 p-3 rounded-full shadow-2xl transition-all duration-300 group-hover:bg-amber-500 group-hover:text-slate-900 group-hover:-translate-y-1">
        <ChevronUp className="w-6 h-6" />
      </div>
    </button>
  );
};

export default BackToTop;
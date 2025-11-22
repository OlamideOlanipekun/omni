import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  isActive: boolean;
  level: number; // 0 to 1
}

const Waveform: React.FC<WaveformProps> = ({ isActive, level }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (!isActive) {
        // Flat line if inactive
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }

      // Dynamic wave based on level
      const centerY = canvas.height / 2;
      ctx.beginPath();
      ctx.moveTo(0, centerY);

      const amplitude = Math.max(10, level * 100); 
      const frequency = 0.05;

      for (let x = 0; x < canvas.width; x++) {
        const y = centerY + Math.sin(x * frequency + offset) * amplitude * Math.sin(x / canvas.width * Math.PI);
        ctx.lineTo(x, y);
      }

      ctx.strokeStyle = '#fbbf24'; // Amber-400
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Second echoing wave
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      for (let x = 0; x < canvas.width; x++) {
        const y = centerY + Math.sin(x * frequency + offset - 1) * (amplitude * 0.6) * Math.sin(x / canvas.width * Math.PI);
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.4)';
      ctx.lineWidth = 2;
      ctx.stroke();

      offset += 0.2;
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, level]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={120} 
      className="w-full h-32 rounded-lg bg-slate-900/50 border border-slate-700 shadow-inner"
    />
  );
};

export default Waveform;
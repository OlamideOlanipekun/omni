export interface User {
  id: string;
  name: string;
  email: string;
}

export interface BookingDetails {
  id?: string;
  name?: string;
  phone?: string;
  email?: string;
  room_type?: string;
  check_in_date?: string;
  check_out_date?: string;
  guests?: string;
  branch?: string;
  special_requests?: string;
  status?: 'confirmed' | 'pending' | 'cancelled';
  created_at?: string;
  confirmation_code?: string;
  // Financials
  price_per_night?: number;
  total_nights?: number;
  total_cost?: number;
  currency?: string;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface LogEntry {
  timestamp: Date;
  role: 'user' | 'ai' | 'system';
  message: string;
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}
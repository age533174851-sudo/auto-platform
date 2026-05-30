// ─────────────────────────────────────────────────────────────
// src/lib/supabase/types.ts
// Database schema types — keep in sync with supabase/schema.sql
// ─────────────────────────────────────────────────────────────

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          avatar_url: string | null;
          role: string;
          plan: string;
          status: string;
          badges: string[];
          expires_at: string | null;
          granted_by: string | null;
          invite_code: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['profiles']['Row']> & { id: string; email: string };
        Update: Partial<Database['public']['Tables']['profiles']['Row']>;
      };
      watchlists: {
        Row: {
          id: string;
          user_id: string;
          symbol: string;
          name_kr: string;
          symbol_ticker: string;
          color: string;
          category: string;
          exchange: string;
          tv_symbol: string | null;
          added_at: string;
        };
        Insert: Omit<Database['public']['Tables']['watchlists']['Row'], 'id' | 'added_at'>;
        Update: Partial<Database['public']['Tables']['watchlists']['Row']>;
      };
      portfolios: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          type: string;  // 'long' | 'short' | 'cash'
          asset_id: string;
          name_kr: string;
          symbol: string;
          color: string;
          avg_price: number;
          quantity: number;
          invested: number;
          target_price: number;
          stop_price: number;
          leverage: number;
          note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['portfolios']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['portfolios']['Row']>;
      };
      trading_strategies: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          type: string;
          asset: string;
          asset_name_kr: string;
          timeframe: string;
          leverage: number;
          max_leverage: number;
          risk_level: string;
          tp: number;
          sl: number;
          enabled: boolean;
          status: string;
          win_rate: number;
          total_pnl: number;
          trades: number;
          max_daily_loss: number;
          max_position_size: number;
          cooldown_min: number;
          params: Json;
          description: string | null;
          exec_mode: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['trading_strategies']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['trading_strategies']['Row']>;
      };
      exchange_connections: {
        Row: {
          id: string;
          user_id: string;
          exchange_id: string;
          label: string | null;
          api_key_masked: string;      // only first/last chars shown
          api_secret_enc: string;      // AES-256-GCM encrypted, never returned to client
          has_withdrawal: boolean;
          is_active: boolean;
          last_tested_at: string | null;
          test_status: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['exchange_connections']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['exchange_connections']['Row']>;
      };
      trade_orders: {
        Row: {
          id: string;
          user_id: string;
          exchange_id: string | null;
          symbol: string;
          name_kr: string;
          side: string;
          price: number;
          quantity: number;
          amount: number;
          leverage: number;
          fee: number;
          slippage: number;
          status: string;
          pnl: number;
          pnl_pct: number;
          mode: string;
          note: string | null;
          emotion: string | null;
          opened_at: string;
          closed_at: string | null;
        };
        Insert: Omit<Database['public']['Tables']['trade_orders']['Row'], 'id'>;
        Update: Partial<Database['public']['Tables']['trade_orders']['Row']>;
      };
      pnl_reports: {
        Row: {
          id: string;
          user_id: string;
          period: string;      // 'YYYY-MM'
          realized_pnl: number;
          unrealized_pnl: number;
          total_fee: number;
          trade_count: number;
          win_count: number;
          loss_count: number;
          win_rate: number;
          best_trade: number;
          worst_trade: number;
          tax_estimate: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['pnl_reports']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['pnl_reports']['Row']>;
      };
      alerts: {
        Row: {
          id: string;
          user_id: string;
          asset_id: string;
          name_kr: string;
          condition: string;  // 'above' | 'below'
          value: number;
          active: boolean;
          triggered_at: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['alerts']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['alerts']['Row']>;
      };
      audit_logs: {
        Row: {
          id: string;
          actor_id: string | null;
          action: string;
          target_id: string | null;
          resource: string | null;
          details: Json | null;
          result: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['audit_logs']['Row'], 'id' | 'created_at'>;
        Update: never;
      };
      backtest_results: {
        Row: {
          id: string;
          user_id: string;
          strategy_id: string | null;
          strategy_name: string;
          asset: string;
          timeframe: string;
          start_date: string;
          end_date: string;
          total_trades: number;
          win_rate: number;
          total_pnl: number;
          max_drawdown: number;
          sharpe_ratio: number | null;
          params: Json;
          equity_curve: Json;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['backtest_results']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['backtest_results']['Row']>;
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

/** Safe client-facing exchange connection (secret stripped) */
export interface ExchangeConnectionSafe {
  id: string;
  exchange_id: string;
  label: string | null;
  api_key_masked: string;
  has_withdrawal: boolean;
  is_active: boolean;
  last_tested_at: string | null;
  test_status: string | null;
  created_at: string;
}

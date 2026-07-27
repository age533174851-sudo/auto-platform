// ─────────────────────────────────────────────────────────────
// src/lib/supabase/types.ts
//
// 이 파일은 Supabase Management API로 실제 DB 스키마에서 생성했다.
// 손으로 고치지 말 것 — 스키마를 바꿨으면 아래로 다시 뽑는다:
//
//   GET https://api.supabase.com/v1/projects/{ref}/types/typescript
//       ?included_schemas=public
//       Authorization: Bearer <personal access token>
// ─────────────────────────────────────────────────────────────
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_notices: {
        Row: {
          active: boolean
          body: string
          created_at: string
          created_by: string | null
          ends_at: string | null
          id: string
          level: string
          show_to: string
          starts_at: string
          title: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          body: string
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          level?: string
          show_to?: string
          starts_at?: string
          title: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          body?: string
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          level?: string
          show_to?: string
          starts_at?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_cache: {
        Row: {
          cache_key: string
          created_at: string
          expires_at: string
          hit_count: number
          kind: string | null
          result: Json
          tier: string | null
        }
        Insert: {
          cache_key: string
          created_at?: string
          expires_at: string
          hit_count?: number
          kind?: string | null
          result: Json
          tier?: string | null
        }
        Update: {
          cache_key?: string
          created_at?: string
          expires_at?: string
          hit_count?: number
          kind?: string | null
          result?: Json
          tier?: string | null
        }
        Relationships: []
      }
      ai_keys: {
        Row: {
          active: boolean
          created_at: string
          id: string
          key_enc: string
          key_masked: string
          last_used_at: string | null
          provider: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          key_enc: string
          key_masked: string
          last_used_at?: string | null
          provider: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          key_enc?: string
          key_masked?: string
          last_used_at?: string | null
          provider?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_usage: {
        Row: {
          cache_hit: boolean
          created_at: string
          credits: number
          id: string
          input_tokens: number | null
          kind: string | null
          output_tokens: number | null
          tier: string
          usage_date: string
          used_own_key: boolean
          user_id: string | null
        }
        Insert: {
          cache_hit?: boolean
          created_at?: string
          credits?: number
          id?: string
          input_tokens?: number | null
          kind?: string | null
          output_tokens?: number | null
          tier: string
          usage_date?: string
          used_own_key?: boolean
          user_id?: string | null
        }
        Update: {
          cache_hit?: boolean
          created_at?: string
          credits?: number
          id?: string
          input_tokens?: number | null
          kind?: string | null
          output_tokens?: number | null
          tier?: string
          usage_date?: string
          used_own_key?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      alerts: {
        Row: {
          active: boolean | null
          alert_type: string | null
          condition: string | null
          created_at: string | null
          id: string
          message: string | null
          name_kr: string | null
          symbol: string
          target_value: number | null
          triggered: boolean | null
          triggered_at: string | null
          user_id: string
        }
        Insert: {
          active?: boolean | null
          alert_type?: string | null
          condition?: string | null
          created_at?: string | null
          id?: string
          message?: string | null
          name_kr?: string | null
          symbol: string
          target_value?: number | null
          triggered?: boolean | null
          triggered_at?: string | null
          user_id: string
        }
        Update: {
          active?: boolean | null
          alert_type?: string | null
          condition?: string | null
          created_at?: string | null
          id?: string
          message?: string | null
          name_kr?: string | null
          symbol?: string
          target_value?: number | null
          triggered?: boolean | null
          triggered_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string | null
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: string | null
          metadata: Json | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      backtest_results: {
        Row: {
          created_at: string | null
          end_date: string | null
          fees: number | null
          final_balance: number | null
          funding_fees: number | null
          id: string
          initial_balance: number | null
          max_drawdown_pct: number | null
          name: string | null
          profit_factor: number | null
          result_data: Json | null
          slippage: number | null
          start_date: string | null
          strategy_id: string | null
          symbol: string
          timeframe: string | null
          total_return_pct: number | null
          total_trades: number | null
          user_id: string
          win_rate: number | null
        }
        Insert: {
          created_at?: string | null
          end_date?: string | null
          fees?: number | null
          final_balance?: number | null
          funding_fees?: number | null
          id?: string
          initial_balance?: number | null
          max_drawdown_pct?: number | null
          name?: string | null
          profit_factor?: number | null
          result_data?: Json | null
          slippage?: number | null
          start_date?: string | null
          strategy_id?: string | null
          symbol: string
          timeframe?: string | null
          total_return_pct?: number | null
          total_trades?: number | null
          user_id: string
          win_rate?: number | null
        }
        Update: {
          created_at?: string | null
          end_date?: string | null
          fees?: number | null
          final_balance?: number | null
          funding_fees?: number | null
          id?: string
          initial_balance?: number | null
          max_drawdown_pct?: number | null
          name?: string | null
          profit_factor?: number | null
          result_data?: Json | null
          slippage?: number | null
          start_date?: string | null
          strategy_id?: string | null
          symbol?: string
          timeframe?: string | null
          total_return_pct?: number | null
          total_trades?: number | null
          user_id?: string
          win_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "backtest_results_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "trading_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_slot_days: {
        Row: {
          consecutive_losses: number
          created_at: string
          halt_reason: string | null
          halted: boolean
          id: string
          max_consecutive_losses: number | null
          max_daily_loss: number | null
          realized_pnl: number
          slot_count: number
          slot_size: number
          slots_used: number
          start_equity: number
          trade_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          consecutive_losses?: number
          created_at?: string
          halt_reason?: string | null
          halted?: boolean
          id?: string
          max_consecutive_losses?: number | null
          max_daily_loss?: number | null
          realized_pnl?: number
          slot_count?: number
          slot_size: number
          slots_used?: number
          start_equity: number
          trade_date: string
          updated_at?: string
          user_id: string
        }
        Update: {
          consecutive_losses?: number
          created_at?: string
          halt_reason?: string | null
          halted?: boolean
          id?: string
          max_consecutive_losses?: number | null
          max_daily_loss?: number | null
          realized_pnl?: number
          slot_count?: number
          slot_size?: number
          slots_used?: number
          start_equity?: number
          trade_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      daily_slot_uses: {
        Row: {
          allocated_margin: number
          closed_at: string | null
          created_at: string
          day_id: string
          entry_price: number | null
          exit_price: number | null
          exit_reason: string | null
          id: string
          leverage: number
          liquidation_price: number | null
          margin_mode: string
          position_size: number
          realized_pnl: number | null
          side: string
          signal_id: string | null
          slot_index: number
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          trade_date: string
          user_id: string
        }
        Insert: {
          allocated_margin: number
          closed_at?: string | null
          created_at?: string
          day_id: string
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          leverage: number
          liquidation_price?: number | null
          margin_mode?: string
          position_size: number
          realized_pnl?: number | null
          side: string
          signal_id?: string | null
          slot_index: number
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          trade_date: string
          user_id: string
        }
        Update: {
          allocated_margin?: number
          closed_at?: string | null
          created_at?: string
          day_id?: string
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          leverage?: number
          liquidation_price?: number | null
          margin_mode?: string
          position_size?: number
          realized_pnl?: number | null
          side?: string
          signal_id?: string | null
          slot_index?: number
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          trade_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_slot_uses_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "daily_slot_days"
            referencedColumns: ["id"]
          },
        ]
      }
      derivatives_daily: {
        Row: {
          coverage: string
          funding_rate: number | null
          oi_change_pct: number | null
          symbol: string
          trade_date: string
          updated_at: string
        }
        Insert: {
          coverage?: string
          funding_rate?: number | null
          oi_change_pct?: number | null
          symbol: string
          trade_date: string
          updated_at?: string
        }
        Update: {
          coverage?: string
          funding_rate?: number | null
          oi_change_pct?: number | null
          symbol?: string
          trade_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      econ_events: {
        Row: {
          actual: string | null
          affected_assets: string[] | null
          country: string | null
          created_at: string
          event: string
          forecast: string | null
          id: string
          impact: string
          previous: string | null
          source: string
          timestamp_utc: string
          updated_at: string
        }
        Insert: {
          actual?: string | null
          affected_assets?: string[] | null
          country?: string | null
          created_at?: string
          event: string
          forecast?: string | null
          id: string
          impact?: string
          previous?: string | null
          source?: string
          timestamp_utc: string
          updated_at?: string
        }
        Update: {
          actual?: string | null
          affected_assets?: string[] | null
          country?: string | null
          created_at?: string
          event?: string
          forecast?: string | null
          id?: string
          impact?: string
          previous?: string | null
          source?: string
          timestamp_utc?: string
          updated_at?: string
        }
        Relationships: []
      }
      exchange_connections: {
        Row: {
          api_key: string
          api_key_encrypted: string | null
          api_key_masked: string | null
          api_passphrase_enc: string | null
          api_secret_enc: string | null
          auto_trading_enabled: boolean | null
          created_at: string | null
          encrypted_passphrase: string | null
          encrypted_secret: string | null
          exchange: string | null
          exchange_id: string | null
          has_withdrawal: boolean
          id: string
          is_active: boolean | null
          is_paper: boolean
          is_testnet: boolean
          label: string | null
          last_error: string | null
          last_health_check: string | null
          last_tested_at: string | null
          nickname: string | null
          perm_read: boolean
          perm_trading: boolean
          permission_read: boolean | null
          permission_trade: boolean | null
          permission_withdraw: boolean | null
          test_status: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          api_key?: string
          api_key_encrypted?: string | null
          api_key_masked?: string | null
          api_passphrase_enc?: string | null
          api_secret_enc?: string | null
          auto_trading_enabled?: boolean | null
          created_at?: string | null
          encrypted_passphrase?: string | null
          encrypted_secret?: string | null
          exchange?: string | null
          exchange_id?: string | null
          has_withdrawal?: boolean
          id?: string
          is_active?: boolean | null
          is_paper?: boolean
          is_testnet?: boolean
          label?: string | null
          last_error?: string | null
          last_health_check?: string | null
          last_tested_at?: string | null
          nickname?: string | null
          perm_read?: boolean
          perm_trading?: boolean
          permission_read?: boolean | null
          permission_trade?: boolean | null
          permission_withdraw?: boolean | null
          test_status?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          api_key?: string
          api_key_encrypted?: string | null
          api_key_masked?: string | null
          api_passphrase_enc?: string | null
          api_secret_enc?: string | null
          auto_trading_enabled?: boolean | null
          created_at?: string | null
          encrypted_passphrase?: string | null
          encrypted_secret?: string | null
          exchange?: string | null
          exchange_id?: string | null
          has_withdrawal?: boolean
          id?: string
          is_active?: boolean | null
          is_paper?: boolean
          is_testnet?: boolean
          label?: string | null
          last_error?: string | null
          last_health_check?: string | null
          last_tested_at?: string | null
          nickname?: string | null
          perm_read?: boolean
          perm_trading?: boolean
          permission_read?: boolean | null
          permission_trade?: boolean | null
          permission_withdraw?: boolean | null
          test_status?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      exchange_connections_backup_20260727: {
        Row: {
          api_key: string | null
          api_key_encrypted: string | null
          api_key_masked: string | null
          api_passphrase_enc: string | null
          api_secret_enc: string | null
          auto_trading_enabled: boolean | null
          created_at: string | null
          encrypted_passphrase: string | null
          encrypted_secret: string | null
          exchange: string | null
          exchange_id: string | null
          has_withdrawal: boolean | null
          id: string | null
          is_active: boolean | null
          is_paper: boolean | null
          is_testnet: boolean | null
          label: string | null
          last_error: string | null
          last_health_check: string | null
          last_tested_at: string | null
          nickname: string | null
          perm_read: boolean | null
          perm_trading: boolean | null
          permission_read: boolean | null
          permission_trade: boolean | null
          permission_withdraw: boolean | null
          test_status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          api_key?: string | null
          api_key_encrypted?: string | null
          api_key_masked?: string | null
          api_passphrase_enc?: string | null
          api_secret_enc?: string | null
          auto_trading_enabled?: boolean | null
          created_at?: string | null
          encrypted_passphrase?: string | null
          encrypted_secret?: string | null
          exchange?: string | null
          exchange_id?: string | null
          has_withdrawal?: boolean | null
          id?: string | null
          is_active?: boolean | null
          is_paper?: boolean | null
          is_testnet?: boolean | null
          label?: string | null
          last_error?: string | null
          last_health_check?: string | null
          last_tested_at?: string | null
          nickname?: string | null
          perm_read?: boolean | null
          perm_trading?: boolean | null
          permission_read?: boolean | null
          permission_trade?: boolean | null
          permission_withdraw?: boolean | null
          test_status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          api_key?: string | null
          api_key_encrypted?: string | null
          api_key_masked?: string | null
          api_passphrase_enc?: string | null
          api_secret_enc?: string | null
          auto_trading_enabled?: boolean | null
          created_at?: string | null
          encrypted_passphrase?: string | null
          encrypted_secret?: string | null
          exchange?: string | null
          exchange_id?: string | null
          has_withdrawal?: boolean | null
          id?: string | null
          is_active?: boolean | null
          is_paper?: boolean | null
          is_testnet?: boolean | null
          label?: string | null
          last_error?: string | null
          last_health_check?: string | null
          last_tested_at?: string | null
          nickname?: string | null
          perm_read?: boolean | null
          perm_trading?: boolean | null
          permission_read?: boolean | null
          permission_trade?: boolean | null
          permission_withdraw?: boolean | null
          test_status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      invite_codes: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          note: string | null
          plan: string
          role: string
          uses_count: number
          uses_max: number | null
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          note?: string | null
          plan?: string
          role?: string
          uses_count?: number
          uses_max?: number | null
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          note?: string | null
          plan?: string
          role?: string
          uses_count?: number
          uses_max?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invite_codes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          action: string
          attempts: number | null
          completed_at: string | null
          connection_id: string | null
          created_at: string | null
          error: string | null
          exchange: string | null
          id: string
          locked_by: string | null
          locked_until: string | null
          max_attempts: number | null
          mode: string | null
          payload: Json | null
          percent: number | null
          priority: number | null
          quantity: number | null
          result: Json | null
          side: string | null
          status: string | null
          symbol: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          attempts?: number | null
          completed_at?: string | null
          connection_id?: string | null
          created_at?: string | null
          error?: string | null
          exchange?: string | null
          id?: string
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number | null
          mode?: string | null
          payload?: Json | null
          percent?: number | null
          priority?: number | null
          quantity?: number | null
          result?: Json | null
          side?: string | null
          status?: string | null
          symbol?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          attempts?: number | null
          completed_at?: string | null
          connection_id?: string | null
          created_at?: string | null
          error?: string | null
          exchange?: string | null
          id?: string
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number | null
          mode?: string | null
          payload?: Json | null
          percent?: number | null
          priority?: number | null
          quantity?: number | null
          result?: Json | null
          side?: string | null
          status?: string | null
          symbol?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      kill_switch_log: {
        Row: {
          action: string | null
          at: string | null
          connection_id: string | null
          drawdown_pct: number | null
          equity: number | null
          id: string
          mode: string | null
          reason: string | null
          user_id: string | null
        }
        Insert: {
          action?: string | null
          at?: string | null
          connection_id?: string | null
          drawdown_pct?: number | null
          equity?: number | null
          id?: string
          mode?: string | null
          reason?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string | null
          at?: string | null
          connection_id?: string | null
          drawdown_pct?: number | null
          equity?: number | null
          id?: string
          mode?: string | null
          reason?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      kill_switch_state: {
        Row: {
          abs_limit_usdt: number | null
          action_mode: string | null
          active: boolean | null
          connection_id: string
          daily_limit_pct: number | null
          daily_start_at: string | null
          daily_start_equity: number | null
          enabled: boolean | null
          monthly_limit_pct: number | null
          monthly_start_at: string | null
          monthly_start_equity: number | null
          trigger_reason: string | null
          triggered_at: string | null
          updated_at: string | null
          user_id: string
          weekly_limit_pct: number | null
          weekly_start_at: string | null
          weekly_start_equity: number | null
        }
        Insert: {
          abs_limit_usdt?: number | null
          action_mode?: string | null
          active?: boolean | null
          connection_id: string
          daily_limit_pct?: number | null
          daily_start_at?: string | null
          daily_start_equity?: number | null
          enabled?: boolean | null
          monthly_limit_pct?: number | null
          monthly_start_at?: string | null
          monthly_start_equity?: number | null
          trigger_reason?: string | null
          triggered_at?: string | null
          updated_at?: string | null
          user_id: string
          weekly_limit_pct?: number | null
          weekly_start_at?: string | null
          weekly_start_equity?: number | null
        }
        Update: {
          abs_limit_usdt?: number | null
          action_mode?: string | null
          active?: boolean | null
          connection_id?: string
          daily_limit_pct?: number | null
          daily_start_at?: string | null
          daily_start_equity?: number | null
          enabled?: boolean | null
          monthly_limit_pct?: number | null
          monthly_start_at?: string | null
          monthly_start_equity?: number | null
          trigger_reason?: string | null
          triggered_at?: string | null
          updated_at?: string | null
          user_id?: string
          weekly_limit_pct?: number | null
          weekly_start_at?: string | null
          weekly_start_equity?: number | null
        }
        Relationships: []
      }
      ladder_cycles: {
        Row: {
          created_at: string
          current_tier_index: number
          cycle_locked: boolean
          cycle_number: number
          cycle_start_at: string
          id: string
          lock_reason: string | null
          protected_profit: number
          realized_equity: number
          strategy_capital: number
          strategy_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_tier_index?: number
          cycle_locked?: boolean
          cycle_number?: number
          cycle_start_at?: string
          id?: string
          lock_reason?: string | null
          protected_profit?: number
          realized_equity: number
          strategy_capital: number
          strategy_id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_tier_index?: number
          cycle_locked?: boolean
          cycle_number?: number
          cycle_start_at?: string
          id?: string
          lock_reason?: string | null
          protected_profit?: number
          realized_equity?: number
          strategy_capital?: number
          strategy_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ladder_daily_trades: {
        Row: {
          allocated_margin: number | null
          closed_at: string | null
          created_at: string
          cycle_id: string | null
          cycle_number: number | null
          entry_price: number | null
          exit_price: number | null
          exit_reason: string | null
          id: string
          leverage: number | null
          liquidation_price: number | null
          realized_pnl: number | null
          side: string | null
          signal_id: string | null
          status: string
          stop_loss: number | null
          strategy_id: string
          symbol: string | null
          take_profit: number | null
          tier_index: number | null
          trade_date: string
          user_id: string
        }
        Insert: {
          allocated_margin?: number | null
          closed_at?: string | null
          created_at?: string
          cycle_id?: string | null
          cycle_number?: number | null
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          realized_pnl?: number | null
          side?: string | null
          signal_id?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id?: string
          symbol?: string | null
          take_profit?: number | null
          tier_index?: number | null
          trade_date: string
          user_id: string
        }
        Update: {
          allocated_margin?: number | null
          closed_at?: string | null
          created_at?: string
          cycle_id?: string | null
          cycle_number?: number | null
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          realized_pnl?: number | null
          side?: string | null
          signal_id?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id?: string
          symbol?: string | null
          take_profit?: number | null
          tier_index?: number | null
          trade_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ladder_daily_trades_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "ladder_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      live_orders: {
        Row: {
          acked_at: string | null
          attempt_count: number
          avg_price: number | null
          client_order_id: string
          connection_id: string | null
          created_at: string
          error_message: string | null
          exchange: string
          exchange_order_id: string | null
          filled_qty: number | null
          id: string
          leverage: number | null
          mode: string
          order_type: string
          price: number | null
          quantity: number
          reconciled_at: string | null
          reduce_only: boolean
          sent_at: string | null
          side: string
          signal_id: string | null
          sl_order_id: string | null
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          tp_order_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          acked_at?: string | null
          attempt_count?: number
          avg_price?: number | null
          client_order_id: string
          connection_id?: string | null
          created_at?: string
          error_message?: string | null
          exchange: string
          exchange_order_id?: string | null
          filled_qty?: number | null
          id?: string
          leverage?: number | null
          mode: string
          order_type?: string
          price?: number | null
          quantity: number
          reconciled_at?: string | null
          reduce_only?: boolean
          sent_at?: string | null
          side: string
          signal_id?: string | null
          sl_order_id?: string | null
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          tp_order_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          acked_at?: string | null
          attempt_count?: number
          avg_price?: number | null
          client_order_id?: string
          connection_id?: string | null
          created_at?: string
          error_message?: string | null
          exchange?: string
          exchange_order_id?: string | null
          filled_qty?: number | null
          id?: string
          leverage?: number | null
          mode?: string
          order_type?: string
          price?: number | null
          quantity?: number
          reconciled_at?: string | null
          reduce_only?: boolean
          sent_at?: string | null
          side?: string
          signal_id?: string | null
          sl_order_id?: string | null
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          tp_order_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      paper_accounts: {
        Row: {
          balance: number
          initial_balance: number
          total_fees: number
          total_pnl: number
          trade_count: number
          updated_at: string
          user_id: string
          win_count: number
        }
        Insert: {
          balance?: number
          initial_balance?: number
          total_fees?: number
          total_pnl?: number
          trade_count?: number
          updated_at?: string
          user_id: string
          win_count?: number
        }
        Update: {
          balance?: number
          initial_balance?: number
          total_fees?: number
          total_pnl?: number
          trade_count?: number
          updated_at?: string
          user_id?: string
          win_count?: number
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          bucket: string | null
          closed_at: string | null
          created_at: string
          entry_fee: number
          entry_price: number
          exit_fee: number | null
          exit_price: number | null
          exit_reason: string | null
          fill_price: number
          gross_pnl: number | null
          id: string
          leverage: number
          liquidation_price: number | null
          margin: number
          notional: number
          opened_at: string
          pnl_pct: number | null
          quantity: number
          realized_pnl: number | null
          side: string
          signal_id: string | null
          status: string
          stop_loss: number | null
          strategy_id: string | null
          symbol: string
          take_profit: number | null
          user_id: string | null
        }
        Insert: {
          bucket?: string | null
          closed_at?: string | null
          created_at?: string
          entry_fee?: number
          entry_price: number
          exit_fee?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          fill_price: number
          gross_pnl?: number | null
          id?: string
          leverage?: number
          liquidation_price?: number | null
          margin: number
          notional: number
          opened_at?: string
          pnl_pct?: number | null
          quantity: number
          realized_pnl?: number | null
          side: string
          signal_id?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol: string
          take_profit?: number | null
          user_id?: string | null
        }
        Update: {
          bucket?: string | null
          closed_at?: string | null
          created_at?: string
          entry_fee?: number
          entry_price?: number
          exit_fee?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          fill_price?: number
          gross_pnl?: number | null
          id?: string
          leverage?: number
          liquidation_price?: number | null
          margin?: number
          notional?: number
          opened_at?: string
          pnl_pct?: number | null
          quantity?: number
          realized_pnl?: number | null
          side?: string
          signal_id?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string
          take_profit?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      pnl_reports: {
        Row: {
          created_at: string | null
          funding_fees: number | null
          id: string
          period_end: string
          period_start: string
          period_type: string
          realized_pnl: number | null
          report_data: Json | null
          total_fees: number | null
          trades_count: number | null
          unrealized_pnl: number | null
          user_id: string
          win_rate: number | null
        }
        Insert: {
          created_at?: string | null
          funding_fees?: number | null
          id?: string
          period_end: string
          period_start: string
          period_type: string
          realized_pnl?: number | null
          report_data?: Json | null
          total_fees?: number | null
          trades_count?: number | null
          unrealized_pnl?: number | null
          user_id: string
          win_rate?: number | null
        }
        Update: {
          created_at?: string | null
          funding_fees?: number | null
          id?: string
          period_end?: string
          period_start?: string
          period_type?: string
          realized_pnl?: number | null
          report_data?: Json | null
          total_fees?: number | null
          trades_count?: number | null
          unrealized_pnl?: number | null
          user_id?: string
          win_rate?: number | null
        }
        Relationships: []
      }
      portfolio_positions: {
        Row: {
          asset_type: string | null
          avg_price: number | null
          created_at: string | null
          current_price: number | null
          id: string
          invested_amount: number | null
          leverage: number | null
          name_kr: string | null
          note: string | null
          portfolio_id: string | null
          quantity: number | null
          side: string | null
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          asset_type?: string | null
          avg_price?: number | null
          created_at?: string | null
          current_price?: number | null
          id?: string
          invested_amount?: number | null
          leverage?: number | null
          name_kr?: string | null
          note?: string | null
          portfolio_id?: string | null
          quantity?: number | null
          side?: string | null
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          asset_type?: string | null
          avg_price?: number | null
          created_at?: string | null
          current_price?: number | null
          id?: string
          invested_amount?: number | null
          leverage?: number | null
          name_kr?: string | null
          note?: string | null
          portfolio_id?: string | null
          quantity?: number | null
          side?: string | null
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_positions_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolios: {
        Row: {
          cash_pct: number | null
          cash_value: number | null
          created_at: string | null
          id: string
          is_default: boolean | null
          long_pct: number | null
          mode: string | null
          name: string | null
          short_pct: number | null
          total_value: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cash_pct?: number | null
          cash_value?: number | null
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          long_pct?: number | null
          mode?: string | null
          name?: string | null
          short_pct?: number | null
          total_value?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cash_pct?: number | null
          cash_value?: number | null
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          long_pct?: number | null
          mode?: string | null
          name?: string | null
          short_pct?: number | null
          total_value?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      position_plans: {
        Row: {
          account_equity: number | null
          approved: boolean
          bucket: string | null
          created_at: string
          effective_stop_pct: number | null
          id: string
          leverage: number | null
          liquidation_dist_pct: number | null
          liquidation_price: number | null
          notes: string[] | null
          position_size: number | null
          quantity: number | null
          reject_code: string | null
          reject_reason: string | null
          required_margin: number | null
          risk_amount: number | null
          side: string
          signal_id: string
          stop_distance_pct: number | null
          strategy_id: string | null
          symbol: string
          user_id: string | null
        }
        Insert: {
          account_equity?: number | null
          approved: boolean
          bucket?: string | null
          created_at?: string
          effective_stop_pct?: number | null
          id?: string
          leverage?: number | null
          liquidation_dist_pct?: number | null
          liquidation_price?: number | null
          notes?: string[] | null
          position_size?: number | null
          quantity?: number | null
          reject_code?: string | null
          reject_reason?: string | null
          required_margin?: number | null
          risk_amount?: number | null
          side: string
          signal_id: string
          stop_distance_pct?: number | null
          strategy_id?: string | null
          symbol: string
          user_id?: string | null
        }
        Update: {
          account_equity?: number | null
          approved?: boolean
          bucket?: string | null
          created_at?: string
          effective_stop_pct?: number | null
          id?: string
          leverage?: number | null
          liquidation_dist_pct?: number | null
          liquidation_price?: number | null
          notes?: string[] | null
          position_size?: number | null
          quantity?: number | null
          reject_code?: string | null
          reject_reason?: string | null
          required_margin?: number | null
          risk_amount?: number | null
          side?: string
          signal_id?: string
          stop_distance_pct?: number | null
          strategy_id?: string | null
          symbol?: string
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          badges: string[]
          created_at: string | null
          default_currency: string | null
          display_name: string | null
          email: string | null
          expires_at: string | null
          granted_by: string | null
          id: string
          invite_code: string | null
          name: string | null
          plan: string
          risk_profile: string | null
          role: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          badges?: string[]
          created_at?: string | null
          default_currency?: string | null
          display_name?: string | null
          email?: string | null
          expires_at?: string | null
          granted_by?: string | null
          id: string
          invite_code?: string | null
          name?: string | null
          plan?: string
          risk_profile?: string | null
          role?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          badges?: string[]
          created_at?: string | null
          default_currency?: string | null
          display_name?: string | null
          email?: string | null
          expires_at?: string | null
          granted_by?: string | null
          id?: string
          invite_code?: string | null
          name?: string | null
          plan?: string
          risk_profile?: string | null
          role?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          created_at: string
          endpoint: string
          expiration: number | null
          keys: Json
          user_id: string | null
        }
        Insert: {
          created_at?: string
          endpoint: string
          expiration?: number | null
          keys?: Json
          user_id?: string | null
        }
        Update: {
          created_at?: string
          endpoint?: string
          expiration?: number | null
          keys?: Json
          user_id?: string | null
        }
        Relationships: []
      }
      risk_limits: {
        Row: {
          fee_rate_pct: number
          max_account_risk_pct: number
          max_daily_loss_pct: number
          max_leverage: number
          max_notional_pct: number
          risk_per_trade_pct: number
          slippage_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          fee_rate_pct?: number
          max_account_risk_pct?: number
          max_daily_loss_pct?: number
          max_leverage?: number
          max_notional_pct?: number
          risk_per_trade_pct?: number
          slippage_pct?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          fee_rate_pct?: number
          max_account_risk_pct?: number
          max_daily_loss_pct?: number
          max_leverage?: number
          max_notional_pct?: number
          risk_per_trade_pct?: number
          slippage_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          bucket: string | null
          confidence: number | null
          created_at: string
          entry_price: number | null
          id: string
          job_id: string | null
          raw_payload: Json | null
          reject_reason: string | null
          signal: string
          signal_id: string
          signal_ts: string | null
          source: string | null
          status: string
          stop_loss: number | null
          strategy_id: string
          symbol: string
          take_profit: number | null
          timeframe: string | null
          user_id: string | null
          warnings: string[] | null
        }
        Insert: {
          bucket?: string | null
          confidence?: number | null
          created_at?: string
          entry_price?: number | null
          id?: string
          job_id?: string | null
          raw_payload?: Json | null
          reject_reason?: string | null
          signal: string
          signal_id: string
          signal_ts?: string | null
          source?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id: string
          symbol: string
          take_profit?: number | null
          timeframe?: string | null
          user_id?: string | null
          warnings?: string[] | null
        }
        Update: {
          bucket?: string | null
          confidence?: number | null
          created_at?: string
          entry_price?: number | null
          id?: string
          job_id?: string | null
          raw_payload?: Json | null
          reject_reason?: string | null
          signal?: string
          signal_id?: string
          signal_ts?: string | null
          source?: string | null
          status?: string
          stop_loss?: number | null
          strategy_id?: string
          symbol?: string
          take_profit?: number | null
          timeframe?: string | null
          user_id?: string | null
          warnings?: string[] | null
        }
        Relationships: []
      }
      strategy_profiles: {
        Row: {
          created_at: string | null
          daily_loss_limit_pct: number | null
          enabled: boolean | null
          id: string
          label: string | null
          leverage: number | null
          margin_mode: string | null
          max_hold_sec: number | null
          max_leverage: number | null
          max_open_positions: number | null
          max_portfolio_pct: number | null
          order_type: string | null
          risk_percent: number | null
          stop_loss_pct: number | null
          strategy_type: string
          take_profit_pct: number | null
          timeout_sec: number | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          daily_loss_limit_pct?: number | null
          enabled?: boolean | null
          id?: string
          label?: string | null
          leverage?: number | null
          margin_mode?: string | null
          max_hold_sec?: number | null
          max_leverage?: number | null
          max_open_positions?: number | null
          max_portfolio_pct?: number | null
          order_type?: string | null
          risk_percent?: number | null
          stop_loss_pct?: number | null
          strategy_type: string
          take_profit_pct?: number | null
          timeout_sec?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          daily_loss_limit_pct?: number | null
          enabled?: boolean | null
          id?: string
          label?: string | null
          leverage?: number | null
          margin_mode?: string | null
          max_hold_sec?: number | null
          max_leverage?: number | null
          max_open_positions?: number | null
          max_portfolio_pct?: number | null
          order_type?: string | null
          risk_percent?: number | null
          stop_loss_pct?: number | null
          strategy_type?: string
          take_profit_pct?: number | null
          timeout_sec?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      telegram_alert_log: {
        Row: {
          aggregated_count: number | null
          channel: string | null
          created_at: string | null
          dedup_key: string | null
          error: string | null
          escalated: boolean | null
          event_type: string | null
          exchange: string | null
          id: string
          message: string | null
          sent: boolean | null
          severity: string | null
          symbol: string | null
          throttled: boolean | null
        }
        Insert: {
          aggregated_count?: number | null
          channel?: string | null
          created_at?: string | null
          dedup_key?: string | null
          error?: string | null
          escalated?: boolean | null
          event_type?: string | null
          exchange?: string | null
          id?: string
          message?: string | null
          sent?: boolean | null
          severity?: string | null
          symbol?: string | null
          throttled?: boolean | null
        }
        Update: {
          aggregated_count?: number | null
          channel?: string | null
          created_at?: string | null
          dedup_key?: string | null
          error?: string | null
          escalated?: boolean | null
          event_type?: string | null
          exchange?: string | null
          id?: string
          message?: string | null
          sent?: boolean | null
          severity?: string | null
          symbol?: string | null
          throttled?: boolean | null
        }
        Relationships: []
      }
      trade_orders: {
        Row: {
          amount: number | null
          closed_at: string | null
          created_at: string | null
          error_message: string | null
          exchange: string | null
          exchange_connection_id: string | null
          external_order_id: string | null
          fee: number | null
          funding_fee: number | null
          id: string
          leverage: number | null
          mode: string | null
          opened_at: string | null
          order_type: string | null
          pnl: number | null
          pnl_pct: number | null
          price: number | null
          quantity: number | null
          side: string
          slippage: number | null
          status: string | null
          strategy_id: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          amount?: number | null
          closed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          exchange?: string | null
          exchange_connection_id?: string | null
          external_order_id?: string | null
          fee?: number | null
          funding_fee?: number | null
          id?: string
          leverage?: number | null
          mode?: string | null
          opened_at?: string | null
          order_type?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          price?: number | null
          quantity?: number | null
          side: string
          slippage?: number | null
          status?: string | null
          strategy_id?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          amount?: number | null
          closed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          exchange?: string | null
          exchange_connection_id?: string | null
          external_order_id?: string | null
          fee?: number | null
          funding_fee?: number | null
          id?: string
          leverage?: number | null
          mode?: string | null
          opened_at?: string | null
          order_type?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          price?: number | null
          quantity?: number | null
          side?: string
          slippage?: number | null
          status?: string | null
          strategy_id?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_orders_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_orders_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "trading_strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_strategies: {
        Row: {
          cooldown_minutes: number | null
          created_at: string | null
          enabled: boolean | null
          exchange: string | null
          id: string
          leverage: number | null
          max_daily_loss: number | null
          max_leverage: number | null
          max_position_size: number | null
          mode: string | null
          name: string
          params: Json | null
          status: string | null
          stop_loss_pct: number | null
          strategy_type: string
          symbol: string
          take_profit_pct: number | null
          timeframe: string | null
          total_pnl: number | null
          trades_count: number | null
          updated_at: string | null
          user_id: string
          win_rate: number | null
        }
        Insert: {
          cooldown_minutes?: number | null
          created_at?: string | null
          enabled?: boolean | null
          exchange?: string | null
          id?: string
          leverage?: number | null
          max_daily_loss?: number | null
          max_leverage?: number | null
          max_position_size?: number | null
          mode?: string | null
          name: string
          params?: Json | null
          status?: string | null
          stop_loss_pct?: number | null
          strategy_type?: string
          symbol: string
          take_profit_pct?: number | null
          timeframe?: string | null
          total_pnl?: number | null
          trades_count?: number | null
          updated_at?: string | null
          user_id: string
          win_rate?: number | null
        }
        Update: {
          cooldown_minutes?: number | null
          created_at?: string | null
          enabled?: boolean | null
          exchange?: string | null
          id?: string
          leverage?: number | null
          max_daily_loss?: number | null
          max_leverage?: number | null
          max_position_size?: number | null
          mode?: string | null
          name?: string
          params?: Json | null
          status?: string | null
          stop_loss_pct?: number | null
          strategy_type?: string
          symbol?: string
          take_profit_pct?: number | null
          timeframe?: string | null
          total_pnl?: number | null
          trades_count?: number | null
          updated_at?: string | null
          user_id?: string
          win_rate?: number | null
        }
        Relationships: []
      }
      user_login_sessions: {
        Row: {
          browser: string | null
          city: string | null
          country: string | null
          created_at: string
          device_name: string | null
          device_type: string | null
          email: string
          id: string
          ip_address: string | null
          is_current: boolean
          last_seen_at: string
          os: string | null
          revoked: boolean
          session_token: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          browser?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          device_name?: string | null
          device_type?: string | null
          email: string
          id?: string
          ip_address?: string | null
          is_current?: boolean
          last_seen_at?: string
          os?: string | null
          revoked?: boolean
          session_token?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          browser?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          device_name?: string | null
          device_type?: string | null
          email?: string
          id?: string
          ip_address?: string | null
          is_current?: boolean
          last_seen_at?: string
          os?: string | null
          revoked?: boolean
          session_token?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_strategies: {
        Row: {
          action: string
          asset: string
          conditions: Json
          created_at: string
          enabled: boolean
          id: string
          market: string
          mode: string
          name: string
          order_spec: Json
          prompt: string | null
          risk: Json
          source: string | null
          timeframe: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action?: string
          asset: string
          conditions?: Json
          created_at?: string
          enabled?: boolean
          id: string
          market: string
          mode?: string
          name: string
          order_spec?: Json
          prompt?: string | null
          risk?: Json
          source?: string | null
          timeframe: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          asset?: string
          conditions?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          market?: string
          mode?: string
          name?: string
          order_spec?: Json
          prompt?: string | null
          risk?: Json
          source?: string | null
          timeframe?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      watchlists: {
        Row: {
          asset_type: string | null
          created_at: string | null
          exchange: string | null
          id: string
          logo_url: string | null
          name_en: string | null
          name_kr: string | null
          sort_order: number | null
          symbol: string
          tv_symbol: string | null
          user_id: string
        }
        Insert: {
          asset_type?: string | null
          created_at?: string | null
          exchange?: string | null
          id?: string
          logo_url?: string | null
          name_en?: string | null
          name_kr?: string | null
          sort_order?: number | null
          symbol: string
          tv_symbol?: string | null
          user_id: string
        }
        Update: {
          asset_type?: string | null
          created_at?: string | null
          exchange?: string | null
          id?: string
          logo_url?: string | null
          name_en?: string | null
          name_kr?: string | null
          sort_order?: number | null
          symbol?: string
          tv_symbol?: string | null
          user_id?: string
        }
        Relationships: []
      }
      webhook_dedup: {
        Row: {
          created_at: string
          expires_at: string
          key: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          key: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          key?: string
        }
        Relationships: []
      }
      worker_heartbeat: {
        Row: {
          current_task: string | null
          error_count: number | null
          last_seen: string | null
          status: string | null
          updated_at: string | null
          worker_id: string
        }
        Insert: {
          current_task?: string | null
          error_count?: number | null
          last_seen?: string | null
          status?: string | null
          updated_at?: string | null
          worker_id: string
        }
        Update: {
          current_task?: string | null
          error_count?: number | null
          last_seen?: string | null
          status?: string | null
          updated_at?: string | null
          worker_id?: string
        }
        Relationships: []
      }
      worker_lock: {
        Row: {
          acquired_at: string | null
          expires_at: string | null
          holder: string | null
          name: string
        }
        Insert: {
          acquired_at?: string | null
          expires_at?: string | null
          holder?: string | null
          name: string
        }
        Update: {
          acquired_at?: string | null
          expires_at?: string | null
          holder?: string | null
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_admin_by_email: {
        Args: { p_email: string }
        Returns: {
          email: string
          id: string
          role: string
        }[]
      }
      cleanup_old_login_sessions: { Args: never; Returns: number }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

// ─────────────────────────────────────────────────────────────
// 수동 정의 — 생성 대상이 아님
// ─────────────────────────────────────────────────────────────

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
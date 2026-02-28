/**
 * Auto-generated Supabase database types
 * Run: npx supabase gen types typescript --linked > lib/database.types.ts
 *
 * This is a manual definition until you run the command above
 */

export type Database = {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string;
          name: string;
          slug: string;
          domain: string | null;
          logo_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          domain?: string | null;
          logo_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          domain?: string | null;
          logo_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          role: string;
          client_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          role: string;
          client_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          role?: string;
          client_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      requests: {
        Row: {
          id: string;
          client_id: string;
          requested_by: string;
          account_number: string;
          status: string;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
          notes: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          requested_by: string;
          account_number: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
          notes?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          requested_by?: string;
          account_number?: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
          notes?: string | null;
        };
      };
      request_entities: {
        Row: {
          id: string;
          request_id: string;
          entity_name: string;
          ein: string;
          form_type: string;
          years: string[];
          status: string;
          gross_receipts: Record<string, unknown> | null;
          compliance_score: number | null;
          transcript_urls: string[] | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          entity_name: string;
          ein: string;
          form_type: string;
          years: string[];
          status?: string;
          gross_receipts?: Record<string, unknown> | null;
          compliance_score?: number | null;
          transcript_urls?: string[] | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          request_id?: string;
          entity_name?: string;
          ein?: string;
          form_type?: string;
          years?: string[];
          status?: string;
          gross_receipts?: Record<string, unknown> | null;
          compliance_score?: number | null;
          transcript_urls?: string[] | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          request_id: string | null;
          type: string;
          sent_at: string;
          channel: string;
          read_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          request_id?: string | null;
          type: string;
          sent_at?: string;
          channel?: string;
          read_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          request_id?: string | null;
          type?: string;
          sent_at?: string;
          channel?: string;
          read_at?: string | null;
        };
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

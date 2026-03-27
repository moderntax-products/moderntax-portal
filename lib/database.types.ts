/**
 * Supabase database types for ModernTax Portal v2
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
          intake_methods: string[];
          free_trial: boolean;
          api_key: string | null;
          api_request_limit: number | null;
          billing_payment_method: string | null;
          billing_ap_email: string | null;
          billing_ap_phone: string | null;
          billing_rate_pdf: number;
          billing_rate_csv: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          domain?: string | null;
          logo_url?: string | null;
          intake_methods?: string[];
          free_trial?: boolean;
          api_key?: string | null;
          api_request_limit?: number | null;
          billing_payment_method?: string | null;
          billing_ap_email?: string | null;
          billing_ap_phone?: string | null;
          billing_rate_pdf?: number;
          billing_rate_csv?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          domain?: string | null;
          logo_url?: string | null;
          intake_methods?: string[];
          free_trial?: boolean;
          api_key?: string | null;
          api_request_limit?: number | null;
          billing_payment_method?: string | null;
          billing_ap_email?: string | null;
          billing_ap_phone?: string | null;
          billing_rate_pdf?: number;
          billing_rate_csv?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          title: string | null;
          role: string;
          client_id: string | null;
          caf_number: string | null;
          ptin: string | null;
          phone_number: string | null;
          fax_number: string | null;
          address: string | null;
          city: string | null;
          state: string | null;
          zip_code: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          title?: string | null;
          role: string;
          client_id?: string | null;
          caf_number?: string | null;
          ptin?: string | null;
          phone_number?: string | null;
          fax_number?: string | null;
          address?: string | null;
          city?: string | null;
          state?: string | null;
          zip_code?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          title?: string | null;
          role?: string;
          client_id?: string | null;
          caf_number?: string | null;
          ptin?: string | null;
          phone_number?: string | null;
          fax_number?: string | null;
          address?: string | null;
          city?: string | null;
          state?: string | null;
          zip_code?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['id'];
          },
        ];
      };
      batches: {
        Row: {
          id: string;
          client_id: string;
          uploaded_by: string;
          intake_method: string;
          source_file_url: string | null;
          original_filename: string | null;
          entity_count: number;
          request_count: number;
          status: string;
          error_message: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          uploaded_by: string;
          intake_method: string;
          source_file_url?: string | null;
          original_filename?: string | null;
          entity_count?: number;
          request_count?: number;
          status?: string;
          error_message?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          uploaded_by?: string;
          intake_method?: string;
          source_file_url?: string | null;
          original_filename?: string | null;
          entity_count?: number;
          request_count?: number;
          status?: string;
          error_message?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'batches_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'batches_uploaded_by_fkey';
            columns: ['uploaded_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      requests: {
        Row: {
          id: string;
          client_id: string;
          requested_by: string;
          batch_id: string | null;
          loan_number: string;
          intake_method: string;
          product_type: string;
          external_request_token: string | null;
          status: string;
          notes: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          requested_by: string;
          batch_id?: string | null;
          loan_number: string;
          intake_method?: string;
          product_type?: string;
          external_request_token?: string | null;
          status?: string;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          requested_by?: string;
          batch_id?: string | null;
          loan_number?: string;
          intake_method?: string;
          product_type?: string;
          external_request_token?: string | null;
          status?: string;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'requests_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'requests_requested_by_fkey';
            columns: ['requested_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'requests_batch_id_fkey';
            columns: ['batch_id'];
            isOneToOne: false;
            referencedRelation: 'batches';
            referencedColumns: ['id'];
          },
        ];
      };
      request_entities: {
        Row: {
          id: string;
          request_id: string;
          entity_name: string;
          tid: string;
          tid_kind: string;
          address: string | null;
          city: string | null;
          state: string | null;
          zip_code: string | null;
          form_type: string;
          years: string[];
          signer_first_name: string | null;
          signer_last_name: string | null;
          signer_email: string | null;
          signature_id: string | null;
          signature_created_at: string | null;
          signed_8821_url: string | null;
          status: string;
          employment_data: Record<string, unknown> | null;
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
          tid: string;
          tid_kind?: string;
          address?: string | null;
          city?: string | null;
          state?: string | null;
          zip_code?: string | null;
          form_type: string;
          years: string[];
          signer_first_name?: string | null;
          signer_last_name?: string | null;
          signature_id?: string | null;
          signature_created_at?: string | null;
          signed_8821_url?: string | null;
          status?: string;
          employment_data?: Record<string, unknown> | null;
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
          tid?: string;
          tid_kind?: string;
          address?: string | null;
          city?: string | null;
          state?: string | null;
          zip_code?: string | null;
          form_type?: string;
          years?: string[];
          signer_first_name?: string | null;
          signer_last_name?: string | null;
          signature_id?: string | null;
          signature_created_at?: string | null;
          signed_8821_url?: string | null;
          status?: string;
          employment_data?: Record<string, unknown> | null;
          gross_receipts?: Record<string, unknown> | null;
          compliance_score?: number | null;
          transcript_urls?: string[] | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'request_entities_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
        ];
      };
      expert_assignments: {
        Row: {
          id: string;
          entity_id: string;
          expert_id: string;
          assigned_by: string;
          assigned_at: string;
          completed_at: string | null;
          sla_deadline: string;
          sla_met: boolean | null;
          status: string;
          miss_reason: string | null;
          expert_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          entity_id: string;
          expert_id: string;
          assigned_by: string;
          assigned_at?: string;
          completed_at?: string | null;
          sla_deadline?: string;
          sla_met?: boolean | null;
          status?: string;
          miss_reason?: string | null;
          expert_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          entity_id?: string;
          expert_id?: string;
          assigned_by?: string;
          assigned_at?: string;
          completed_at?: string | null;
          sla_deadline?: string;
          sla_met?: boolean | null;
          status?: string;
          miss_reason?: string | null;
          expert_notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'expert_assignments_entity_id_fkey';
            columns: ['entity_id'];
            isOneToOne: false;
            referencedRelation: 'request_entities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expert_assignments_expert_id_fkey';
            columns: ['expert_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'expert_assignments_assigned_by_fkey';
            columns: ['assigned_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invoices: {
        Row: {
          id: string;
          client_id: string;
          invoice_number: string;
          billing_period_start: string;
          billing_period_end: string;
          total_entities: number;
          total_amount: number;
          status: string;
          payment_method: string | null;
          mercury_reference: string | null;
          due_date: string | null;
          sent_at: string | null;
          paid_at: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          client_id: string;
          invoice_number: string;
          billing_period_start: string;
          billing_period_end: string;
          total_entities?: number;
          total_amount?: number;
          status?: string;
          payment_method?: string | null;
          mercury_reference?: string | null;
          due_date?: string | null;
          sent_at?: string | null;
          paid_at?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          client_id?: string;
          invoice_number?: string;
          billing_period_start?: string;
          billing_period_end?: string;
          total_entities?: number;
          total_amount?: number;
          status?: string;
          payment_method?: string | null;
          mercury_reference?: string | null;
          due_date?: string | null;
          sent_at?: string | null;
          paid_at?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invoices_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['id'];
          },
        ];
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
        Relationships: [
          {
            foreignKeyName: 'notifications_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_my_client_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      get_my_role: {
        Args: Record<string, never>;
        Returns: string;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

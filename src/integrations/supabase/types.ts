export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      activity_events: {
        Row: {
          content_id: string | null;
          created_at: string;
          event_type: string;
          id: string;
          industry: string | null;
          user_email: string | null;
          user_id: string;
        };
        Insert: {
          content_id?: string | null;
          created_at?: string;
          event_type: string;
          id?: string;
          industry?: string | null;
          user_email?: string | null;
          user_id?: string;
        };
        Update: {
          content_id?: string | null;
          created_at?: string;
          event_type?: string;
          id?: string;
          industry?: string | null;
          user_email?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      chat_messages: {
        Row: {
          citations: Json;
          content: string;
          created_at: string;
          id: string;
          role: string;
          thread_id: string;
        };
        Insert: {
          citations?: Json;
          content: string;
          created_at?: string;
          id?: string;
          role: string;
          thread_id: string;
        };
        Update: {
          citations?: Json;
          content?: string;
          created_at?: string;
          id?: string;
          role?: string;
          thread_id?: string;
        };
        Relationships: [];
      };
      chat_threads: {
        Row: {
          created_at: string;
          id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      content_items: {
        Row: {
          content_type: string;
          created_at: string;
          customer_name: string | null;
          description: string | null;
          file_name: string;
          file_path: string;
          file_size: number | null;
          id: string;
          industry: string;
          mime_type: string | null;
          solution: string | null;
          title: string;
          uploaded_by: string;
          uploader_email: string | null;
        };
        Insert: {
          content_type?: string;
          created_at?: string;
          customer_name?: string | null;
          description?: string | null;
          file_name: string;
          file_path: string;
          file_size?: number | null;
          id?: string;
          industry: string;
          mime_type?: string | null;
          solution?: string | null;
          title: string;
          uploaded_by?: string;
          uploader_email?: string | null;
        };
        Update: {
          content_type?: string;
          created_at?: string;
          customer_name?: string | null;
          description?: string | null;
          file_name?: string;
          file_path?: string;
          file_size?: number | null;
          id?: string;
          industry?: string;
          mime_type?: string | null;
          solution?: string | null;
          title?: string;
          uploaded_by?: string;
          uploader_email?: string | null;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          created_at: string;
          created_by: string;
          id: string;
          industry: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string;
          id?: string;
          industry: string;
          name: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          id?: string;
          industry?: string;
          name?: string;
        };
        Relationships: [];
      };
      document_chunks: {
        Row: {
          chunk_index: number;
          content: string;
          content_id: string;
          created_at: string;
          embedding: string;
          embedding_model: string;
          estimated_tokens: number;
          heading: string | null;
          id: string;
          page: number | null;
          slide: number | null;
          tsv: unknown;
        };
        Insert: {
          chunk_index: number;
          content: string;
          content_id: string;
          created_at?: string;
          embedding: string;
          embedding_model?: string;
          estimated_tokens: number;
          heading?: string | null;
          id?: string;
          page?: number | null;
          slide?: number | null;
        };
        Update: {
          chunk_index?: number;
          content?: string;
          content_id?: string;
          created_at?: string;
          embedding?: string;
          embedding_model?: string;
          estimated_tokens?: number;
          heading?: string | null;
          id?: string;
          page?: number | null;
          slide?: number | null;
        };
        Relationships: [];
      };
      industries: {
        Row: {
          created_at: string;
          created_by: string | null;
          image_url: string | null;
          name: string;
          slug: string;
          tagline: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          image_url?: string | null;
          name: string;
          slug: string;
          tagline?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          image_url?: string | null;
          name?: string;
          slug?: string;
          tagline?: string | null;
        };
        Relationships: [];
      };
      ingestion_jobs: {
        Row: {
          attempts: number;
          chunk_count: number;
          content_hash: string | null;
          content_id: string;
          created_at: string;
          dimensions: number;
          embedding_model: string;
          error: string | null;
          finished_at: string | null;
          id: string;
          not_before: string;
          started_at: string | null;
          status: string;
          updated_at: string;
          warnings: Json;
        };
        Insert: {
          attempts?: number;
          chunk_count?: number;
          content_hash?: string | null;
          content_id: string;
          created_at?: string;
          dimensions?: number;
          embedding_model?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          not_before?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          warnings?: Json;
        };
        Update: {
          attempts?: number;
          chunk_count?: number;
          content_hash?: string | null;
          content_id?: string;
          created_at?: string;
          dimensions?: number;
          embedding_model?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          not_before?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          warnings?: Json;
        };
        Relationships: [];
      };
      request_quotas: {
        Row: {
          key: string;
          requests: number;
          window_start: string;
        };
        Insert: {
          key: string;
          requests?: number;
          window_start: string;
        };
        Update: {
          key?: string;
          requests?: number;
          window_start?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      activity_summary: { Args: { _days?: number }; Returns: Json };
      consume_request_quota: {
        Args: { _kind: string; _network: string; _subject: string };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_allowed_email: { Args: { _email: string }; Returns: boolean };
      is_content_admin: { Args: never; Returns: boolean };
      match_document_chunks: {
        Args: {
          filter_industry?: string | null;
          match_count?: number;
          query_embedding: string;
        };
        Returns: Array<{
          chunk_id: string;
          content: string;
          content_id: string;
          customer_name: string | null;
          distance: number;
          file_name: string;
          heading: string | null;
          industry: string;
          page: number | null;
          slide: number | null;
          title: string;
        }>;
      };
      manage_company: {
        Args: {
          _delete?: boolean;
          _industry: string;
          _name: string;
          _new_name?: string;
        };
        Returns: undefined;
      };
      replace_document_chunks: {
        Args: {
          p_chunks: Json;
          p_content_hash?: string | null;
          p_content_id: string;
          p_status?: string;
          p_warnings?: Json;
        };
        Returns: number;
      };
      search_chunks: {
        Args: {
          filter_customer?: string | null;
          filter_industry?: string | null;
          match_count?: number;
          query_embedding: string;
          query_text?: string | null;
        };
        Returns: Array<{
          chunk_id: string;
          content: string;
          content_id: string;
          customer_name: string | null;
          file_name: string;
          file_path: string;
          heading: string | null;
          industry: string;
          page: number | null;
          score: number;
          slide: number | null;
          text_rank: number | null;
          title: string;
          vector_rank: number | null;
        }>;
      };
    };
    Enums: {
      app_role: "admin" | "member";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "member"],
    },
  },
} as const;

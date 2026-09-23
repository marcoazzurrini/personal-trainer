export interface ContextEntry {
  id: number;
  topic: string;
  content: string;
  written_at: string;
}

export interface AppendContextInput {
  topic: string;
  content: string;
  request_id: string;
}

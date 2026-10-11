export interface BlockRow {
  id: number;
  name: string;
  goal: string;
  started_on: string;
  ended_on: string | null;
}

export interface OpenBlockInput {
  name: string;
  goal: string;
  started_on: string;
  ended_on?: string | null;
  request_id: string;
}

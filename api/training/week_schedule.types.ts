export interface WeekScheduleRow {
  week_start: string;
  week_end: string;
  schedule: string;
  written_at: string;
}

export interface WriteWeekScheduleInput {
  week_start?: string | null;
  schedule: string;
}

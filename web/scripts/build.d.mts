export interface DashboardBuild {
  revision: string | null;
  digest: string;
}
export const placeholder: string;
export function stampOutput(
  directory: string,
  revision: string | null,
): Promise<DashboardBuild>;
export function buildDashboard(): Promise<DashboardBuild>;

import { createServerFn } from "@tanstack/react-start";

export const loadDashboard = createServerFn({ method: "GET" }).handler(
  async () => {
    const { getAuthKitContext } = await import(
      "@workos/authkit-tanstack-react-start"
    );
    const { readDashboard } = await import("./dashboard.server");
    return await readDashboard(getAuthKitContext().auth());
  },
);

import { buildApp } from "./app";

const port = Number(process.env.PORT ?? 3000);

buildApp().listen(port, () => {
  console.log(`payout service listening on http://localhost:${port}`);
});

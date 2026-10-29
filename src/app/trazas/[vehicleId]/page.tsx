import { Suspense } from "react";
import { TraceViewPage } from "@/ui/views/trace";

export default function TracePage() {
  return (
    <Suspense>
      <TraceViewPage />
    </Suspense>
  );
}

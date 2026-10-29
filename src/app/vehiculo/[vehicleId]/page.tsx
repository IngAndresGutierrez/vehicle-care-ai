import { Suspense } from "react";
import { VehicleView } from "@/ui/views/vehicle";

export default function VehiclePage() {
  return (
    <Suspense>
      <VehicleView />
    </Suspense>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/client";
import { CustomerInline } from "./customer-inline";

export function CustomerQuickDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <Dialog open={open} onClose={onClose} title="New customer">
      <p className="mb-3 text-[13px] text-muted">Only name and mobile are needed now. Add passport, IDs and preferences on the customer page.</p>
      <CustomerInline onCreated={(c) => { onClose(); router.push(`/customers/${c.id}`); }} />
    </Dialog>
  );
}

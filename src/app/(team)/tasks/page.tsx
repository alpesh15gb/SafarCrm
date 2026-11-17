import { redirect } from "next/navigation";

// The Tasks page was removed (owner, 2026-11-18): the office works from cases only. Automatic reminders show as
// alerts on each case, and the case list's "Needs attention" section gathers the ones due. Old links land there.
export default function TasksPage() {
  redirect("/cases");
}

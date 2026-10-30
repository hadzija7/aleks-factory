import { KanbanBoard } from "@/components/kanban-board";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Aleks Factory</h1>
        <p className="text-sm opacity-60">Drag a task to “In Execution” to hand it to the Mozaik agent.</p>
      </header>
      <KanbanBoard />
    </main>
  );
}

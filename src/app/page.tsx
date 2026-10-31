import { ProjectList } from "@/components/project-list";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Aleks Factory</h1>
        <p className="text-sm opacity-60">Create a project, then hand its tasks to Mozaik agents.</p>
      </header>
      <ProjectList />
    </main>
  );
}

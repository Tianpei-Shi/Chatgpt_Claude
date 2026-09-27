export type Status = 'queued' | 'dispatching' | 'delivery_unknown' | 'running' | 'completed' | 'failed' | 'needs_input' | 'disconnected' | 'cancelled';
export type Outcome = 'completed' | 'failed' | 'needs_input';
export interface TaskInput { id: string; sessionId: string; cwd: string; prompt: string }
export interface Task extends TaskInput {
  status: Status; createdAt: string; updatedAt: string; report?: string; lease?: string; note?: string;
}
export interface Session {
  id: string; cwd: string; online: boolean; activeTask?: string; lastEvent?: string; updatedAt: string;
}
export interface Registration { id: string; cwd: string; socket: string; token: string }
export type Role = 'codex' | 'claude' | 'hook';
export interface Endpoint { port: number; instance: string; keys: Record<Role, string> }

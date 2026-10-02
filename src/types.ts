export type Status = 'queued' | 'dispatching' | 'delivery_unknown' | 'running' | 'completed' | 'failed' | 'needs_input' | 'disconnected' | 'cancelled';
export type Outcome = 'completed' | 'failed' | 'needs_input';
export interface TaskInput { id: string; sessionId: string; cwd: string; prompt: string; contextId?: string; planId?: string; mode?: 'read' | 'write' }
export interface Task extends TaskInput {
  status: Status; createdAt: string; updatedAt: string; report?: string; lease?: string; note?: string;
  events?: Activity[]; interactions?: Interaction[];
}
export interface Activity { sequence: number; at: string; event: string; tool?: string; text: string }
export type InteractionKind = 'question' | 'permission' | 'elicitation';
export interface Interaction {
  id: string; taskId: string; sessionId: string; kind: InteractionKind; hookEvent: string;
  payload: Record<string, any>; status: 'pending' | 'answered' | 'delivered' | 'expired';
  createdAt: string; expiresAt: string; polledAt: string; answer?: Record<string, any>; rationale?: string;
}
export interface Session {
  initializationId?: string;
  id: string; cwd: string; online: boolean; activeTask?: string; lastEvent?: string; updatedAt: string;
}
export interface Registration { id: string; cwd: string; socket: string; token: string; initializationId?: string }
export type Role = 'codex' | 'claude' | 'hook';
export interface Endpoint { port: number; instance: string; keys: Record<Role, string> }

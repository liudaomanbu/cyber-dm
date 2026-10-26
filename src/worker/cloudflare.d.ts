declare module 'cloudflare:workers' {
 export class DurableObject<Env> {
  protected env:Env;
  protected ctx:import('@cloudflare/workers-types').DurableObjectState;
  constructor(ctx:import('@cloudflare/workers-types').DurableObjectState,env:Env);
 }
}

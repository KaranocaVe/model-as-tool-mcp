import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelEngine } from '../src/engine.js';
import { parseConfig } from '../src/config.js';
import { ModelError, type AppConfig, type CallContext } from '../src/types.js';
const caps = { roles: ['system','user','assistant'], input: ['text'], output: ['text'], streaming: true, json: true, jsonSchema: true, options: ['temperature','topP','maxTokens','stop','seed'] };
function config(policy: Record<string, unknown> = {}): AppConfig { return parseConfig({ providers: { p: { type: 'openai', baseUrl: 'https://example.com/v1' } }, models: { a: { provider: 'p', model: 'real-a', capabilities: caps, aliases: ['alias-a'], pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' } }, b: { provider: 'p', model: 'real-b', capabilities: caps } }, policy }); }
const req = { model: 'a', messages: [{ role: 'user' as const, content: 'hello' }] };
const ok = () => ({ model: 'upstream', provider: 'upstream', text: 'answer' });
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(a => {resolve=a}); return {promise,resolve}; }
const principal = (tenant: string, models = ['a','b'], scopes = ['*']): CallContext => ({ principal: { tenant, models, scopes } });
afterEach(() => { vi.useRealTimers(); });
describe('explicit engine behavior', () => {
  it('does one call by default and sanitizes secrets', async () => {
    const generate = vi.fn().mockRejectedValue(new ModelError('HTTP_ERROR','SECRET',true,503));
    const engine = new ModelEngine(config(), {openai:{generate}});
    await expect(engine.ask(req)).rejects.toMatchObject({code:'HTTP_ERROR',message:'Model request failed'});
    expect(generate).toHaveBeenCalledTimes(1); expect(engine.records()).toEqual([]);
  });
  it('authorizes every fallback before any request', async () => {
    const generate = vi.fn().mockResolvedValue(ok()); const engine = new ModelEngine(config(), {openai:{generate}});
    await expect(engine.ask({...req,fallback:['b']},principal('one',['a']))).rejects.toMatchObject({code:'FORBIDDEN'}); expect(generate).not.toHaveBeenCalled();
  });
  it('retries and falls back only when opted in', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new ModelError('HTTP_ERROR','temporary',true)).mockRejectedValueOnce(new ModelError('HTTP_ERROR','temporary',true)).mockResolvedValue(ok());
    const engine = new ModelEngine(config(), {openai:{generate}});
    const result = await engine.ask({...req, retry:{maxAttempts:2,baseDelayMs:0,maxDelayMs:0},fallback:['b']});
    expect(generate).toHaveBeenCalledTimes(3); expect(result.model).toBe('b'); expect(result.meta?.attempts).toBe(3);
  });
  it('isolates cache tenants and returned objects', async () => {
    const generate = vi.fn().mockResolvedValue(ok()); const engine = new ModelEngine(config({cache:{enabled:true,ttlMs:10000,maxEntries:5}}),{openai:{generate}});
    const first = await engine.ask(req,principal('one')); first.text='mutated';
    expect((await engine.ask(req,principal('one'))).text).toBe('answer'); expect((await engine.ask(req,principal('one'))).meta?.cacheHit).toBe(true);
    await engine.ask(req,principal('two')); expect(generate).toHaveBeenCalledTimes(2);
  });
  it('deduplicates with independent subscriber cancellation and tenant boundaries', async () => {
    const pending = deferred<ReturnType<typeof ok>>(); const generate = vi.fn().mockImplementation(()=>pending.promise);
    const engine = new ModelEngine(config({deduplicate:true}),{openai:{generate}}); const controller = new AbortController();
    const first=engine.ask(req,{...principal('one'),signal:controller.signal}); const second=engine.ask(req,principal('one')); const third=engine.ask(req,principal('two'));
    controller.abort(); await expect(first).rejects.toMatchObject({code:'CANCELLED'}); pending.resolve(ok());
    const [same,different]=await Promise.all([second,third]); expect(generate).toHaveBeenCalledTimes(2); expect(same.meta?.deduplicated).toBe(true); expect(different.meta?.deduplicated).toBeUndefined();
  });
  it('cancels queued work and bounds admission', async () => {
    const pending=deferred<ReturnType<typeof ok>>(); const generate=vi.fn().mockImplementation(()=>pending.promise);
    const engine=new ModelEngine(config({concurrency:1,maxQueue:1}),{openai:{generate}});
    const first=engine.ask(req); const controller=new AbortController(); const second=engine.ask(req,{signal:controller.signal});
    await expect(engine.ask(req)).rejects.toMatchObject({code:'QUEUE_FULL'}); controller.abort(); await expect(second).rejects.toMatchObject({code:'CANCELLED'});
    expect(engine.stats()).toMatchObject({queued:0}); pending.resolve(ok()); await first; expect(generate).toHaveBeenCalledTimes(1);
  });
  it('includes queue time in timeout', async () => {
    vi.useFakeTimers(); const pending=deferred<ReturnType<typeof ok>>(); const generate=vi.fn().mockImplementation(()=>pending.promise);
    const engine=new ModelEngine(config({concurrency:1,maxQueue:5,timeoutMs:5000}),{openai:{generate}});
    const first=engine.ask(req); const second=engine.ask({...req,timeoutMs:10}); const failure=expect(second).rejects.toMatchObject({code:'TIMEOUT'});
    await vi.advanceTimersByTimeAsync(10); await failure; expect(generate).toHaveBeenCalledTimes(1); pending.resolve(ok()); await first;
  });
  it('commits session history transactionally and rejects overlapping writes', async () => {
    const pending=deferred<ReturnType<typeof ok>>(); const generate=vi.fn().mockImplementationOnce(()=>pending.promise).mockRejectedValueOnce(new Error('SECRET'));
    const engine=new ModelEngine(config({sessions:{enabled:true,ttlMs:1000,maxSessions:4,maxMessages:8}}),{openai:{generate}}); const session=engine.createSession('a',principal('one'));
    const first=engine.ask({sessionId:session.id,messages:req.messages},principal('one'));
    await expect(engine.ask({sessionId:session.id,messages:req.messages},principal('one'))).rejects.toMatchObject({code:'SESSION_BUSY'});
    await expect(engine.ask({sessionId:session.id,messages:req.messages},principal('two'))).rejects.toMatchObject({code:'UNKNOWN_SESSION'});
    pending.resolve(ok()); await first; expect(engine.getSession(session.id,principal('one')).messages).toHaveLength(2);
    await expect(engine.ask({sessionId:session.id,messages:req.messages},principal('one'))).rejects.toMatchObject({code:'PROVIDER_ERROR'}); expect(engine.getSession(session.id,principal('one')).messages).toHaveLength(2);
  });
  it('validates JSON schema and does not cache invalid responses', async () => {
    const generate=vi.fn().mockResolvedValue({...ok(),text:JSON.stringify({count:'wrong'})}); const engine=new ModelEngine(config({cache:{enabled:true,ttlMs:1000,maxEntries:4}}),{openai:{generate}});
    const input={...req,options:{responseFormat:{type:'json_schema' as const,schema:{type:'object',required:['count'],properties:{count:{type:'number'}}}}}};
    await expect(engine.ask(input)).rejects.toMatchObject({code:'INVALID_RESPONSE'}); await expect(engine.ask(input)).rejects.toMatchObject({code:'INVALID_RESPONSE'}); expect(generate).toHaveBeenCalledTimes(2);
  });
  it('derives cost only from complete actual token usage', async () => {
    const generate=vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce({...ok(),usage:{inputTokens:100,outputTokens:20}}); const engine=new ModelEngine(config(),{openai:{generate}});
    expect((await engine.ask(req)).usage).toBeUndefined(); expect((await engine.ask(req)).meta?.cost).toEqual({amount:0.00014,currency:'USD'});
  });
  it('bounds records, omits content, and applies model ACL', async () => {
    const generate=vi.fn().mockResolvedValue(ok()); const engine=new ModelEngine(config({records:{enabled:true,maxEntries:1,includeContent:false}}),{openai:{generate}});
    await engine.ask(req,principal('one')); await engine.ask(req,principal('two')); expect(engine.records(principal('one'))).toEqual([]);
    const record=engine.records(principal('two'))[0]; expect(record?.messages).toBeUndefined(); expect(record?.response).toBeUndefined(); expect(engine.records(principal('two',['b']))).toEqual([]);
  });
  it('enforces scopes for model calls and probes', async () => {
    const probe=vi.fn().mockResolvedValue({available:true}); const engine=new ModelEngine(config(),{openai:{generate:async()=>ok(),probe}});
    expect(()=>engine.listModels(principal('one',['a'],[]))).toThrow('Access denied'); await expect(engine.probe('b',principal('one',['a']))).rejects.toMatchObject({code:'FORBIDDEN'}); expect(probe).not.toHaveBeenCalled();
    await expect(engine.ask(req,principal('one',['a'],[]))).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('stops retries and fallback after stream output', async () => {
    const generate=vi.fn().mockImplementation(async (_p,_m,_msgs,_o,ctx) => { await ctx.onEvent({type:'text',text:'partial'}); throw new ModelError('HTTP_ERROR','failure',true); });
    const engine=new ModelEngine(config(),{openai:{generate}});
    await expect(engine.ask({...req,stream:true,retry:{maxAttempts:3},fallback:['b']})).rejects.toMatchObject({code:'STREAM_INTERRUPTED'});
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('filters statistics after a model permission is revoked', async () => {
    const engine=new ModelEngine(config(),{openai:{generate:async()=>({...ok(),usage:{inputTokens:10,outputTokens:20}})}});
    await engine.ask(req,principal('one')); expect(engine.stats(principal('one',['a'])).providerCalls).toBe(1);
    expect(engine.stats(principal('one',['b'])).providerCalls).toBe(0);
  });
  it('keeps capacity occupied until a noncooperative adapter settles', async () => {
    const pending=deferred<ReturnType<typeof ok>>(); const generate=vi.fn().mockImplementationOnce(()=>pending.promise).mockResolvedValue(ok());
    const engine=new ModelEngine(config({concurrency:1,maxQueue:0}),{openai:{generate}}); const controller=new AbortController();
    const first=engine.ask(req,{signal:controller.signal}); await Promise.resolve(); controller.abort(); await expect(first).rejects.toMatchObject({code:'CANCELLED'});
    await expect(engine.ask(req)).rejects.toMatchObject({code:'QUEUE_FULL'}); pending.resolve(ok()); await vi.waitFor(()=>expect(engine.stats().active).toBe(0));
    await engine.ask(req); expect(generate).toHaveBeenCalledTimes(2);
  });
  it('probes undeclared capabilities on a temporary copy with both scopes', async () => {
    const c=config(); c.models.a!.capabilities.json=false;
    const generate=vi.fn().mockResolvedValue({...ok(),text:'{}'}); const engine=new ModelEngine(c,{openai:{generate}});
    await expect(engine.ask({...req,options:{responseFormat:{type:'json'}}})).rejects.toMatchObject({code:'UNSUPPORTED_OPTION'});
    await expect(engine.detectCapabilities('a',['json'],principal('one',['a'],['models:probe']))).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(engine.detectCapabilities('b',['json'],principal('one',['a'],['models:probe','models:ask']))).rejects.toMatchObject({code:'FORBIDDEN'});
    const result=await engine.detectCapabilities('a',['json'],principal('one',['a'],['models:probe','models:ask']));
    expect(result.results[0]).toMatchObject({status:'supported',declared:false,rationaleCode:'OBSERVED_SUCCESS_DECLARATION_CONFLICT'});
    expect(generate.mock.calls[0]![1].capabilities.json).toBe(true); expect(c.models.a!.capabilities.json).toBe(false);
    await expect(engine.ask({...req,options:{responseFormat:{type:'json'}}})).rejects.toMatchObject({code:'UNSUPPORTED_OPTION'});
  });
});

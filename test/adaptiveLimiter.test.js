import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveLimiter, CircuitBreaker } from '../src/pipeline/adaptiveLimiter.js';

test('additive increase is capped', () => {
  const limiter = new AdaptiveLimiter({min:1,max:5,start:4,stepUp:.5});
  limiter.onSuccess(); assert.equal(limiter.limit,4.5);
  limiter.onSuccess(); limiter.onSuccess(); assert.equal(limiter.limit,5);
});

test('multiplicative decrease stops at minimum', () => {
  const limiter = new AdaptiveLimiter({min:2,max:16,start:12});
  limiter.onThrottle(); assert.equal(limiter.limit,6);
  limiter.onThrottle(); assert.equal(limiter.limit,3);
  limiter.onThrottle(); assert.equal(limiter.limit,2);
  assert.equal(limiter.concurrency,2);
});

test('queued work respects a concurrency limit of one', async () => {
  const limiter = new AdaptiveLimiter({min:1,max:4,start:1});
  let active=0,peak=0;
  const results=await Promise.all(Array.from({length:6},(_,i)=>limiter.schedule(async()=>{
    active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,3));
    active--; return i;
  })));
  assert.equal(peak,1);
  assert.deepEqual(results,[0,1,2,3,4,5]);
});

test('breaker opens and recovers after cooldown', () => {
  const breaker=new CircuitBreaker({threshold:2,cooldownMs:25});
  breaker.onFailure(); assert.equal(breaker.canRequest(),true);
  breaker.onFailure(); assert.equal(breaker.canRequest(),false);
  breaker.openedAt=Date.now()-30;
  assert.equal(breaker.canRequest(),true);
  assert.equal(breaker.state,'half-open');
  breaker.onSuccess(); assert.equal(breaker.state,'closed');
  assert.equal(breaker.failures,0);
});

test('success clears the failure streak', () => {
  const breaker=new CircuitBreaker({threshold:3});
  breaker.onFailure();breaker.onFailure();
  breaker.onSuccess();breaker.onFailure();
  assert.equal(breaker.state,'closed');
  assert.equal(breaker.failures,1);
});

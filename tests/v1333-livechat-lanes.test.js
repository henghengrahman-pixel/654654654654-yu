import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const make=()=>new LiveChatClient({base:'https://example.test',accountId:'acct',pat:'pat',requesterUserId:'bot@example.com',inboxMode:'all_active'});

test('v1.33.3 lane classifier separates MY_CHAT QUEUED SUPERVISED and CLOSED',()=>{
  const lc=make();
  assert.equal(lc.classifyChatLane({id:'mine',is_followed:true,users:[{id:'bot@example.com',type:'agent'}],last_thread_summary:{active:true}}),'MY_CHAT');
  assert.equal(lc.classifyChatLane({id:'queue',is_followed:false,last_thread_summary:{active:true}}),'QUEUED');
  assert.equal(lc.classifyChatLane({id:'queue2',routing_status:'queued',last_thread_summary:{active:true}}),'QUEUED');
  assert.equal(lc.classifyChatLane({id:'sup',is_supervised:true,is_followed:true,last_thread_summary:{active:true}}),'SUPERVISED');
  assert.equal(lc.classifyChatLane({id:'closed',routing_status:'closed'}),'CLOSED');
});

test('v1.33.3 followed chat without requester membership becomes supervised when provider exposes users',()=>{
  const lc=make();
  const chat={id:'s1',is_followed:true,users:[{id:'human@example.com',type:'agent'},{id:'customer-1',type:'customer'}],last_thread_summary:{active:true}};
  assert.equal(lc.classifyChatLane(chat),'SUPERVISED');
});

test('v1.33.3 legacy active response without lane signals stays MY_CHAT to avoid silent loss',()=>{
  const lc=make();
  assert.equal(lc.classifyChatLane({id:'legacy',last_thread_summary:{active:true}}),'MY_CHAT');
});

test('v1.33.3 hot poll only enqueues MY_CHAT while other lanes remain lightweight',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/if\(lane==='MY_CHAT'\)\{/);
  assert.match(src,/lightweight\+\+/);
  assert.match(src,/QUEUED\/SUPERVISED are metadata-only lanes/);
  assert.match(src,/sourceLane!==['"]MY_CHAT['"]/);
});

test('v1.33.3 traffic is explicitly excluded from AI polling',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/traffic:\{polled:false,processing:false/);
  assert.match(src,/Browsing traffic is intentionally excluded from AI chat processing/);
});

test('v1.33.3 migration stores indexed LiveChat lane without dropping existing schema',()=>{
  const src=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(src,/ADD COLUMN IF NOT EXISTS lc_lane TEXT NOT NULL DEFAULT 'MY_CHAT'/);
  assert.match(src,/idx_conversations_lane_order/);
  assert.match(src,/lc_lane=EXCLUDED\.lc_lane/);
});

test('v1.33.3 conversations API can filter lanes and returns counts',()=>{
  const src=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.match(src,/\['ALL','MY_CHAT','QUEUED','SUPERVISED'\]/);
  assert.match(src,/\(\$7='ALL' OR c\.lc_lane=\$7\)/);
  assert.match(src,/laneCounts=\{MY_CHAT:0,QUEUED:0,SUPERVISED:0\}/);
});

test('v1.33.3 dashboard exposes separate lane tabs and provider Traffic without polling it',()=>{
  const html=fs.readFileSync(new URL('../public/pages/conversations.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../public/assets/js/pages/conversations.js',import.meta.url),'utf8');
  assert.match(html,/data-lane="MY_CHAT"/);
  assert.match(html,/data-lane="QUEUED"/);
  assert.match(html,/data-lane="SUPERVISED"/);
  assert.match(html,/https:\/\/my\.livechatinc\.com\/engage\/traffic/);
  assert.match(js,/lane:'MY_CHAT'/);
  assert.match(js,/lane:state\.lane/);
});

test('v1.33.3 5000-chat lane simulation keeps only MY_CHAT eligible for heavy processing',()=>{
  const lc=make();
  const chats=[];
  for(let i=0;i<5000;i++){
    if(i%10<2) chats.push({id:`m${i}`,is_followed:true,users:[{id:'bot@example.com',type:'agent'}],last_thread_summary:{active:true}});
    else if(i%10<7) chats.push({id:`q${i}`,is_followed:false,last_thread_summary:{active:true}});
    else chats.push({id:`s${i}`,is_followed:true,is_supervised:true,last_thread_summary:{active:true}});
  }
  const counts={MY_CHAT:0,QUEUED:0,SUPERVISED:0};
  for(const c of chats) counts[lc.classifyChatLane(c)]++;
  assert.deepEqual(counts,{MY_CHAT:1000,QUEUED:2500,SUPERVISED:1500});
  assert.equal(counts.MY_CHAT,1000);
});

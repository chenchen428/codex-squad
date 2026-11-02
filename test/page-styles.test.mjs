import test from 'node:test';import assert from 'node:assert/strict';
import {createPageStyles} from '../cli/ui/page-styles.mjs';
class Link extends EventTarget{constructor(){super();this.dataset={};this.media='all'}remove(){this.removed=true}}
function fixture(){const links=[],fonts=[];const document={createElement:()=>new Link(),head:{append:link=>links.push(link)},fonts:{load:async face=>fonts.push(face)}};return{links,fonts,styles:createPageStyles(document)}}
const config=key=>({key,fontFiles:['shared-font.css','shared-font.css'],cssFile:key+'.css',fontFaces:['400 14px Test']});
test('switch waits for both CSS and fonts and leaves the current page active until commit',async()=>{
 const {styles,links}=fixture(),a=styles.prepare(config('board'));links.forEach(l=>l.dispatchEvent(new Event('load')));await a;styles.activate('board');
 const first=links[0],b=styles.prepare(config('analysis')),next=links.at(-1);assert.equal(first.media,'all');assert.equal(next.media,'not all');assert.equal(styles.isReady('analysis'),false);assert.throws(()=>styles.activate('analysis'));
 next.dispatchEvent(new Event('load'));await b;assert.equal(first.media,'all');styles.activate('analysis');assert.equal(next.media,'all');assert.equal(first.media,'not all');
});
test('font requests finish before ready, duplicate preparation shares requests and cached return is synchronous',async()=>{
 const {styles,links}=fixture();
 const first=styles.prepare(config('board')),duplicate=styles.prepare(config('board'));assert.equal(first,duplicate);assert.equal(links.length,2);links.forEach(l=>l.dispatchEvent(new Event('load')));await first;
 const again=styles.prepare(config('board'));await again;assert.equal(styles.isReady('board'),true);assert.equal(links.length,2);
});
test('a failed target retains current styles and can be retried without poisoning font or CSS cache',async()=>{
 const {styles,links}=fixture(),a=styles.prepare(config('board'));links.forEach(l=>l.dispatchEvent(new Event('load')));await a;styles.activate('board');
 const failed=styles.prepare(config('analysis'));links.at(-1).dispatchEvent(new Event('error'));await assert.rejects(failed,/加载失败/);assert.equal(links[0].media,'all');assert.equal(styles.isReady('analysis'),false);
 const retry=styles.prepare(config('analysis'));links.at(-1).dispatchEvent(new Event('load'));await retry;styles.activate('analysis');assert.equal(links.at(-1).media,'all');
});


test('the next page remains unready until requested font faces finish loading',async()=>{
 const links=[];let release;const document={createElement:()=>new Link(),head:{append:link=>links.push(link)},fonts:{load:()=>new Promise(resolve=>release=resolve)}};
 const styles=createPageStyles(document),ready=styles.prepare(config('board'));links.forEach(l=>l.dispatchEvent(new Event('load')));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(styles.isReady('board'),false);release([]);await ready;assert.equal(styles.isReady('board'),true);
});

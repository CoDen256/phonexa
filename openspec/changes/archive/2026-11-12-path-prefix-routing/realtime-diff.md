# `js/realtime.js` — the entire diff of this change

Recorded per task 6.7. The freeze covers the frame pipeline and the wire
protocol; these two lines are deployment configuration.

```diff
@@ -9,8 +9,8 @@
  *      white noise — Praat's LPC needs periodicity, not noise
  */
 
-const STREAM_URL = (location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/stream';
-const HTTP_URL = '';
+const STREAM_URL = (location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+(window.PHONEXA_PREFIX||'')+'/stream';
+const HTTP_URL = window.PHONEXA_PREFIX || '';
 const TRAIL_DOTS    = 50;     // keep last N voiced frames
 const TRAIL_COLOR   = '#ffd700'; // gold — matches reference style
 
```

Wire-format check (task 6.4): the first frame through `/phonexa/stream` is
byte-identical to the first frame taken directly from `/stream`.

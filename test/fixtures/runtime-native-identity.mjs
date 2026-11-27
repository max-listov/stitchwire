import { observeProcessInstance } from 'stitchkit/process';

console.log(JSON.stringify(await observeProcessInstance(process.pid)));

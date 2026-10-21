const realExit = process.exit.bind(process);

process.exit = () => {};
process.on('disconnect', () => realExit(0));
process.on('SIGTERM', () => realExit(0));
process.on('SIGINT', () => realExit(0));

require('formula-interpreter/dist/evalJob.js');

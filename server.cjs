const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const allowed = {'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/logic.js':'logic.js','/app.js':'app.js','/audio.js':'audio.js','/pi.js':'pi.js','/light.js':'light.js','/buzz.js':'buzz.js'};
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript'};
const server = http.createServer((req,res)=>{
 const file=allowed[new URL(req.url,'http://localhost').pathname];
 if(!file){res.writeHead(404);res.end('Not found');return;}
 fs.readFile(path.join(__dirname,file),(error,data)=>{if(error){res.writeHead(500);res.end('Unable to load file');return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]+'; charset=utf-8','Cache-Control':'no-store'});res.end(data);});
});
const port = Number(process.env.PORT || 4317);
server.listen(port,'127.0.0.1',()=>console.log('Awarely.ai running at http://awarely.localhost:' + port + ' (also http://localhost:' + port + ')'));

console.log("Starting Socket Server For Niotron's Socket.io Compoennt...");

/* 1st npm init -y,
 |
 +- Required Modules
    |
    +- 1. express ['npm install express']
    +- 2. http ['npm unstall http']
    +- 3. socket.io ['npm install socket.io'] 
*/
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const socket = require("socket.io")(http); 

/* Start HTTP Server ON PORT 80 
|  In your case you can change the port.
|  Run 'node server.js' or 'npm start' command on terminal to start the server.
|  And if you are also using port 80 the simply type localhost/you IPV4 address on your feb. browser and htt enter.
|  To know your IPV4 address simply type 'ipconfig' in terminal and hit enter.
*/
const port = process.env.PORT || 3000;
http.listen(port, ()=>{
	console.log("Listning to port " + port);
});

app.get("/",(req,res)=>{
    res.send("Wohoo.. Our server is live now");
});
/*
app.post("/broadcast",(req, res)=>{
    console.log(req.body.mdata);
    res.send("Wohoo.. Our server is live now");
})
*/
socket.on("connect", (io)=>{
    console.log("New User Connected.  ID : " + io.id);

    /*Start Listning to the client request*/
    io.on("New_Message",(data)=>{
        /* 
           New_Message is the event name on which we'll emit & Listen to data to & from our app
           you can rename 'New_Message' with your desired event name.
        */
        socket.emit("New_Message",data);
    });
});

/* NOTE
   I am running this node on my pc which i can access locally to use it in app i have to put this on a live server.  
   So for now i am using ngrok to make this local server live on internet so i can use it with niotron builder for Socket.io app
   For more info about how to use ngrok visit https://ngrok.com/
   It'll generate a random URL like http://93ad60ede325.ngrok.io/ this is your server URL.
*/

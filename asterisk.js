var inherits = require('sys').inherits;
var EventEmitter = require('events').EventEmitter;
var net = require('net');
var sys = require('sys');

var CRLF = "\r\n";
var END = "\r\n\r\n";

exports.AsteriskManager = function (newconfig) {
	EventEmitter.call(this);
	var default_config = {
		user: null,
		password: null,
		host: 'localhost',
		port: 5038,
		events: 'on',
		connect_timeout: 0, // the time to wait for a connection to the Asterisk server (in milliseconds)
	        version: '1.6' //accepted versions: 1.4 - 1.6
	};
	var config;
	var tmoConn = null;
	var conn = null;
	var self = this;
	var loggedIn_ = false;
	var loginId = null;
	var buffer = "";

	var actions = {};
	var partcipants = {};

	this.setConfig = function(newconfig) {
		config = {};
		for (var option in default_config)
			config[option] = (typeof newconfig[option] != "undefined" ? newconfig[option] : default_config[option]);
	};

	this.send = function(req, cb) {
		var id = (new Date()).getTime();

		/* 		
		 * In some case id of different operation can be the same.
		 */
		while(actions[id]!=undefined){	
			id += Math.random()*100000;
		}
		// End of bug fix

		actions[id] = {request: req, callback: cb};
		var msg = "";
		for (var key in req)
			msg += key + ": " + req[key] + CRLF;
		msg += "actionid: " + id + CRLF + CRLF;
		if (req.action == 'login')
			loginId = id;
		self.conn.write(msg);
		console.log("send: " + sys.inspect(msg));
	};
	
	this.getParticipant = function(id) {
		return self.participants[id];
	}

	this.OnConnect = function() {
		self.participants = {};
		if (config.connect_timeout > 0)
			clearTimeout(self.tmoConn);
		self.emit('serverconnect');
	};
	
	this.OnError = function(err) {
		self.conn.end();
		self.emit('servererror', err);
	};
	
	this.OnClose = function(had_error) {
		self.emit('serverdisconnect', had_error);
		self.conn.destroy();
		loggedIn_ = false;
	};
	
	this.OnEnd = function() {
		self.conn.end();
		this.OnClose(false);
	};

	this.OnData = function(tcpbuffer) {
		data = tcpbuffer.toString();
		if (data.substr(0, 21) == "Asterisk Call Manager")
			data = data.substr(data.indexOf(CRLF)+2); // skip the server greeting when first connecting
		buffer += data;
		var iDelim, info, headers, kv, type;
		while ((iDelim = buffer.indexOf(END)) > -1) {
			info = buffer.substring(0, iDelim+2).split(CRLF);
			buffer = buffer.substr(iDelim + 4);
			headers = {}; type = ""; kv = [];
			for (var i=0,len=info.length; i<len; i++) {
				if (info[i].indexOf(": ") == -1)
					continue;
				kv = info[i].split(": ", 2);
				kv[0] = kv[0].toLowerCase().replace("-", "");
				if (i==0)
					type = kv[0];
				headers[kv[0]] = kv[1];

				/* 
				 * This piece of code is to manage UserEvent event emitted by asterisk when DND is activated
				 * and disactivated. It add the key "extra" to headers returned byt the event that contains
				 * " extra: 'Family: DND^Value: Attivo^' " or " extra: 'Family: DND^Value: ^^'  ".
				 *
				 * An example of headers when the DND is activated by means of phone is:
				 * { event: 'UserEvent',
				 *  privilege: 'user,all',
				 *  userevent: 'ASTDB',
				 *  channel: 'SIP/503-0000000d^Family',
				 *  extra: 'Family: DND^Value: Attivo^' }
				 *
				 * An example of headers when the DND is disabled by means of phone is:
				 * { event: 'UserEvent',
				 *  privilege: 'user,all',
				 *  userevent: 'ASTDB',
				 *  channel: 'SIP/503-0000000d^Family',
				 *  extra: 'Family: DND^Value: ^^' }
 				 */
                                if(info[i].indexOf("^")!=-1){
                                        var temp = info[i].split("^");
                                        var extra = '';
                                        for(i=1; i<temp.length; i++){
                                                extra += temp[i] + "^";
                                        }
                                        headers.extra = extra;
                                }
                                // end of UserEvent code

			}
			switch (type) {
				case "response":
					self.OnResponse(headers);
				break;
				case "event":
					self.OnEvent(headers);
				break;
			}
		}
	};

	this.OnResponse = function(headers) {
		var id = headers.actionid, req = actions[id];
		if (id == loginId && headers.response == "Success")
			loggedIn_ = true;
		if (typeof req.callback == 'function'){
			req.callback(headers);
		}
		delete actions[id];
	};
      
    this.OnEvent = function(headers) {
        if (config.version == "1.4")
        {
            switch (headers.event) {
                case "Newchannel": // new participant
                    self.participants[headers.uniqueid] = {name: headers.calleridname, number: headers.calleridnum};
                break;
                case "Newcallerid": // potentially more useful information on an existing participant
                    if (typeof self.participants[headers.uniqueid]['number'] == 'undefined')
                        self.participants[headers.uniqueid]['number'] = headers.callerid;
                    if (headers.calleridname[0] != "<")
                        self.participants[headers.uniqueid]['name'] = headers.calleridname;
                break;
                case "Dial": // source participant is dialing a destination participant
                    self.participants[headers.srcuniqueid]['with'] = headers.destuniqueid;
                    self.participants[headers.destuniqueid]['with'] = headers.srcuniqueid;
                    self.emit('dialing', self.participants[headers.srcuniqueid], self.participants[headers.destuniqueid]);
                break;
                case "Link": // the participants have been connected and voice is now available
                    self.emit('callconnected', self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
                break;
                case "Unlink": // call has ended and the participants are disconnected from each other
                    self.emit('calldisconnected', self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
                break;
                case "Hold": // someone put someone else on hold
                    self.emit('hold', self.participants[headers.uniqueid]);
                break;
                case "Unhold": // someone took someone else off of hold
                    self.emit('unhold', self.participants[headers.uniqueid]);
                break;
                case "Hangup": // fires for each participant and contains the cause for the participant's hangup
                    self.emit('hangup', self.participants[headers.uniqueid], headers.cause, headers.causetxt);
                break;
                case "Cdr": // call data record. contains a ton of useful info about the call (whether it was successful or not) that recently ended
                    var idCaller = headers.uniqueid, idCallee = self.participants[idCaller]['with'], status = headers.disposition.toLowerCase();
                    // use 'callreport' instead of 'callrecord' so as not to potentially confuse 'record' as in recording the voice(s) call, ala monitoring
                    self.emit('callreport', {
                        caller: self.participants[idCaller],
                        callee: self.participants[idCallee],
                        startTime: headers.starttime,
                        answerTime: headers.answertime,
                        endTime: headers.endtime,
                        totalDuration: headers.duration, // in seconds
                        talkDuration: headers.billableseconds, // in seconds
                        finalStatus: status
                    });
                    delete self.participants[idCaller];
                    delete self.participants[idCallee];
                break;
                case "Newstate":
                case "Registry":
                case "Newexten":
                    // ignore theseas they aren't generally useful for ordinary tasks
                break;
                default:
                    //sys.debug("ASTERISK: Got unknown event '" + headers.event + "' with data: " + sys.inspect(headers));
           }
        }
        else if (config.version == '1.6')
        {
             switch (headers.event) {

		case "UserEvent":
			self.emit('userevent', headers);
		break;
		case "PeerStatus":
			self.emit('peerstatus', headers);
		break;
		case "PeerEntry":
			self.emit('peerentry', headers);
		break;
		case "PeerlistComplete":
			self.emit('peerlistcomplete');
		break;
		case "QueueMember":
			self.emit('queuemember', headers);
		break;
		case "ParkedCall":
			self.emit('parkedcall', headers);
		break;
		case "ParkedCallTimeOut":
			self.emit('parkedcalltimeout', headers);
		break;
		case "ParkedCallsComplete":
			self.emit('parkedcallscomplete', headers);
		break;

	        case "Newchannel": // new participant
                        var tmp = headers.channel.split('-');
                        var channel = tmp[0];
                        var extension = tmp[0].split('/');
                        extension = extension[1];
			self.participants[headers.uniqueid] = {name: headers.calleridname != "device" ? headers.calleridname : channel , number: headers.calleridnum != "" ? headers.calleridnum : extension};
	        break;
	
	        case "Join": // Agent joined queue event
                	//sys.debug("ASTERISK JOIN: Got event '" + headers.event + "' with data: " + sys.inspect(headers));
	        break;

	        case "AgentCalled": // Agent on queue called
			self.emit('agentcalled', headers.calleridnum, headers.calleridname, headers.queue, headers.destinationchannel);
	        break;

	        case "Newcallerid": // potentially more useful information on an existing participant
		        if (typeof self.participants[headers.uniqueid]['number'] == 'undefined')
				        self.participants[headers.uniqueid]['number'] = headers.calleridnum;
		        if (headers.calleridname[0] != "")
			        self.participants[headers.uniqueid]['name'] = headers.calleridname;
	        break;

	        case "Dial": // source participant is dialing a destination participant
		        
                        switch(headers.dialstatus)
                        {
                            case "CANCEL":
                                //self.emit('hangup', self.participants[headers.uniqueid], 'End', headers.dialstatus);
                            break;

                            case "ANSWER":
                                self.emit('call', self.participants[headers.uniqueid]);
                            break;

                            default:
		                self.participants[headers.uniqueid]['with'] = headers.uniqueid;
                                if( headers.destuniqueid)
		                    self.participants[headers.destuniqueid]['with'] = headers.destuniqueid;
		                self.emit('dialing', self.participants[headers.uniqueid], self.participants[headers.destuniqueid]);
                        }
		break;
	
		case "Bridge": // the participants have been connected and voice is now available
                        if (headers.bridgestate == "Link")
		            self.emit('callconnected', self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
                        else if (headers.bridgestate == "Unlink")
		            self.emit('calldisconnected', self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
	        break;
	
	        case "Hold": // someone put someone else on hold
                        if (headers.status == "On")
		            self.emit('hold', self.participants[headers.uniqueid]);
                        else
		            self.emit('unhold', self.participants[headers.uniqueid]);
	        break;
	
	        case "Hangup": // fires for each participant and contains the cause for the participant's hangup
		        self.emit('hangup', self.participants[headers.uniqueid], headers.cause, headers.causetxt);
	        break;

	        case "Cdr": // call data record. contains a ton of useful info about the call (whether it was successful or not) that recently ended
		        var idCaller = headers.uniqueid, idCallee = self.participants[idCaller]['with'], status = headers.disposition.toLowerCase();
		        // use 'callreport' instead of 'callrecord' so as not to potentially confuse 'record' as in recording the voice(s) call, ala monitoring
		        self.emit('callreport', {
			        caller: self.participants[idCaller],
			        callee: self.participants[idCallee],
			        startTime: headers.starttime,
			        answerTime: headers.answertime,
			        endTime: headers.endtime,
			        totalDuration: headers.duration, // in seconds
			        talkDuration: headers.billableseconds, // in seconds
			        finalStatus: status
		        });
		        delete self.participants[idCaller];
		        delete self.participants[idCallee];
	        break;

	        case "Newstate": //look for a peer status change
			self.emit('newstate', headers);
		break;

		case "Registry":
		case "Newexten":
		        // ignore theseas they aren't generally useful for ordinary tasks
		break;
		
	        default:
		        //sys.debug("ASTERISK: Got unknown event '" + headers.event + "' with data: " + sys.inspect(headers));
	     }
	}
    };
    

	this.connect = function() {
		if (!self.conn || self.conn.readyState == 'closed') {
			self.conn = net.createConnection(config.port, config.host);
			self.conn.addListener('connect', self.OnConnect);
			//self.conn.addListener('error', self.OnError); // disable for now to get a better idea of source of bugs/errors
			self.conn.addListener('close', self.OnClose);
			self.conn.addListener('end', self.OnEnd);
			self.conn.addListener('data', self.OnData);
			if (config.connect_timeout > 0) {
				self.tmoConn = setTimeout(function() {
					self.emit('timeout');
					self.conn.end();
				}, config.connect_timeout);
			}
		}
	};
	
	this.login = function(cb) {
		if (!loggedIn_ && self.conn.readyState == 'open') {
			self.send({
				action: 'login',
				username: config.user,
				secret: config.password,
				events: config.events
			}, cb);
		}
	};
	
	
	
	this.disconnect = function() {
		if (self.conn.readyState == 'open')
			self.conn.end();
	};
	
	this.__defineGetter__('loggedIn', function () { return loggedIn_; });
	
	this.setConfig(newconfig);
};

inherits(exports.AsteriskManager, EventEmitter);

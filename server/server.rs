// This file is part of Xentimbre, which is released under the GNU General Public License v3 or later.
// See the COPYING or LICENSE file in the root directory of this project or visit <http://www.gnu.org/licenses/gpl-3.0.html>.  

use std::net::{TcpListener, TcpStream, Shutdown};
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

const REQ_LEN_MAX: usize = 4096;
const APP_DIR: &str = "/root/app/";

fn main() {
    let sock = TcpListener::bind("0.0.0.0:80").unwrap();
    for client in sock.incoming() {
        match client {
            Ok(client) => { std::thread::spawn(|| { handle_client(client) }); },
            Err(e) => println!("{}", e)
        }
    }
}

fn handle_client(mut client: TcpStream) {
    let mut buffer = [0; REQ_LEN_MAX];
    let mut maintain_connection = true;

    while maintain_connection {
        let req_len = client.read(&mut buffer).unwrap_or_else(|_| 0);        
        if req_len == 0 { break; }
        else if req_len == REQ_LEN_MAX {
            let response = "HTTP/1.1 413 Payload Too Large";
            client.write_all(response.as_bytes()).unwrap_or_else(|_| ()); 
            break; 
        }
        let request = std::str::from_utf8(&buffer[..req_len]).unwrap_or_else(|_| { "" });
        if request == "" { break; }
        print!("======== ");
        {
            let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() - 14400; // EST offset
            let secs_today = time % 86400;
            print!("{:05} {:02}:{:02}:{:02}", time / 86400, secs_today / 3600, (secs_today % 3600) / 60, secs_today % 60);
            
        }
        println!(" ========\n{}\n================================", request);
        
        let first_two_spaces: Vec<usize> = request.char_indices()
            .filter(|&(_, c)| c == ' ').map(|(i, _)| i).take(2).collect();
        if first_two_spaces.len() != 2 { break; }

        if vec!["GET", "HEAD", "OPTIONS"].iter().all(|&m| m != &request[..first_two_spaces[0]]) {
            let response = "HTTP/1.1 501 Not Implemented\r\n\r\n";
            client.write_all(response.as_bytes()).unwrap();
            continue;
        }
        if &request[..first_two_spaces[0]] == "HEAD" { maintain_connection = false; }
        else { match (
            request.find("HTTP/1.1"), 
            request.find("HTTP/1.0"), 
            request.find("Connection: keep-alive"),
            request.find("Connection: close")
        ) {
            (None, Some(_), None, None) => maintain_connection = false,
            (Some(_), None, None, Some(_)) => maintain_connection = false,
            (None, None, _, _) => {
                let response = "HTTP/1.1 505 HTTP Version Not Supported\r\n\r\n";
                client.write_all(response.as_bytes()).unwrap();
                break;
            },
            _ => ()
        } }
        if &request[..first_two_spaces[0]] == "OPTIONS" {
            let response = "HTTP/1.1 204 No Content\r\nServer: Custom (Unix)\r\nAllow: OPTIONS, GET, HEAD\r\nConnection: keep-alive\r\n\r\n";
            client.write_all(response.as_bytes()).unwrap();
            continue;
        }
        let file: (&str, &str) = match &request[(first_two_spaces[0] + 1)..first_two_spaces[1]] {
            "/" => ("index.html", "text/html"), 
            "/about" => ("about/index.html", "text/html"),
            "/xt.css" => ("xt.css", "text/css"),
            "/app.css" => ("app.css", "text/css"),
            "/app.js" => ("app.js", "application/javascript"),
            "/app-util.js" => ("app-util.js", "application/javascript"),
            "/Ubuntu-Regular.ttf" => ("Ubuntu-Regular.ttf", "font/ttf"),
            "/icon.png" => ("icon.png", "image/png"),
            "/favicon.ico" => ("icon.png", "image/png"),
            "/github.png" => ("github.png", "image/png"),
            _ => {
                let response = "HTTP/1.1 302 Found\r\nLocation: /\r\n\r\n";
                client.write_all(response.as_bytes()).unwrap();
                break;
            }
        };
        let data = std::fs::read(format!("{}{}", APP_DIR, file.0)).unwrap();
        let do_mobile_warn = file.0 == "index.html" && (request.contains("obile") || request.contains("iPhone") || request.contains("iPad") || request.contains("ndroid"));
        let mobile_str = b"\n<script>alert(\"This webapp is intended for computers with external keyboards, not mobile devices. You can still access this page; just understand it will not display or function as intended. If you are not on a mobile device but still seeing this popup, please submit a bug report on Github including what device/browser you were using.\")</script>\n";

        let header = format!(
            "HTTP/1.1 200 OK\r\nServer: Custom (Unix)\r\nConnection: {}\r\nAccept-Ranges: none\r\nContent-Length: {}\r\nContent-Type: {}\r\n\r\n",
            if maintain_connection { "keep-alive" } else { "close" }, data.len() + if do_mobile_warn { mobile_str.len() } else { 0 }, file.1
        );
        match &request[..first_two_spaces[0]] {
            "HEAD" => client.write_all(header.as_bytes()).unwrap(),
            "GET" => {
                let mut response: Vec<u8> = Vec::from(header.as_bytes());
                response.extend(data);
                if do_mobile_warn { response.extend(mobile_str); }
                client.write_all(&response).unwrap();            
            },
            _ => panic!("Somehow failed to parse the HTTP method: {}", &request[..first_two_spaces[0]])
        } 
    }
    client.shutdown(Shutdown::Both).unwrap();
}

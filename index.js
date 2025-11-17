// server/socket.js
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const PORT = process.env.WS_PORT || 3002;
const MIN_PLAYERS = 2;

const server = http.createServer((req, res) => {
    // API /notify – giữ nguyên cho hệ thống notify bạn đã làm
    if (req.method === "POST" && req.url === "/notify") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const { userId, message, newScore } = JSON.parse(body || "{}");
            io.to(userId).emit("notify", { message, newScore });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

const io = new Server(server, {
    cors: { origin: "*" },
});

// ====== GAME STATE ======
let players = new Set();        // danh sách userId đang join game
let bets = {};                  // { userId: { bet: 'tai' | 'xiu', amount: number } }
let phase = "waiting_players";  // waiting_players | betting | locked | reveal | payout
let countdown = 0;

let resultDice = [];
let resultTotal = 0;
let resultType = "";            // 'tai' | 'xiu'

// ====== HELPER ======
function broadcast(event, data) {
    io.emit(event, data);
}

function setPhase(newPhase, time = 0) {
    phase = newPhase;
    countdown = time;

    broadcast("phase_change", { phase, countdown });
}

// ====== MAIN GAME FLOW ======
function startGame() {
    console.log("🎮 BẮT ĐẦU VÁN GAME MỚI");
    bets = {};

    // Bắt đầu giai đoạn đặt cược
    setPhase("betting", 40);

    const bettingInterval = setInterval(() => {
        countdown--;
        broadcast("countdown", { countdown });

        if (countdown <= 0) {
            clearInterval(bettingInterval);
            startReveal();
        }
    }, 1000);
}

function startReveal() {
    setPhase("locked");
    console.log("🔒 ĐÃ KHÓA CƯỢC");

    setTimeout(() => {
        setPhase("reveal", 5);

        // random 3 viên xúc xắc
        resultDice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
        ];

        resultTotal = resultDice.reduce((a, b) => a + b, 0);
        resultType = resultTotal > 10 ? "tai" : "xiu";

        console.log("🎲 KẾT QUẢ:", resultDice, "→", resultTotal, resultType);

        broadcast("reveal", {
            dice: resultDice,
            total: resultTotal,
            type: resultType,
        });

        const revealInterval = setInterval(() => {
            countdown--;
            broadcast("countdown", { countdown });

            if (countdown <= 0) {
                clearInterval(revealInterval);
                startPayout();
            }
        }, 1000);
    }, 2000);
}

function startPayout() {
    setPhase("payout", 10);

    let winners = [];

    Object.keys(bets).forEach((uid) => {
        const userBet = bets[uid];
        if (userBet && userBet.bet === resultType) {
            const winAmount = userBet.amount * 2;
            winners.push({ userId: uid, winAmount });

            // Gọi API Next.js cộng điểm
            fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/game/reward`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userId: uid,
                    amount: winAmount,
                }),
            }).catch((e) => console.error("Reward API error:", e));
        }
    });

    console.log("🏆 WINNERS:", winners);

    broadcast("payout", { winners });

    const payoutInterval = setInterval(() => {
        countdown--;
        broadcast("countdown", { countdown });

        if (countdown <= 0) {
            clearInterval(payoutInterval);
            restartGame();
        }
    }, 1000);
}

function restartGame() {
    setPhase("waiting_players");
    console.log("⏸ ĐỢI NGƯỜI CHƠI... (hiện có:", players.size, ")");

    if (players.size >= MIN_PLAYERS) {
        setTimeout(() => {
            if (players.size >= MIN_PLAYERS && phase === "waiting_players") {
                startGame();
            }
        }, 2000);
    }
}

// ====== SOCKET EVENTS ======
io.on("connection", (socket) => {
    console.log("⚡ Client connected:", socket.id);
    let userId = null;

    socket.on("identify", (id) => {
        userId = id;
        players.add(id);
        socket.join(id);

        console.log("🔗 Player join game:", id, "→ current:", players.size);

        // Gửi trạng thái hiện tại
        socket.emit("game_state", {
            phase,
            countdown,
            dice: resultDice,
            total: resultTotal,
            type: resultType,
        });

        // Nếu đang chờ người chơi & đủ người → start game
        if (phase === "waiting_players" && players.size >= MIN_PLAYERS) {
            startGame();
        }
    });

    // Client gửi đặt cược sau khi đã bị trừ điểm ở Next
    socket.on("bet", ({ bet, amount }) => {
        if (!userId) return;
        if (phase !== "betting") return;
        if (!["tai", "xiu"].includes(bet)) return;

        bets[userId] = { bet, amount };
        console.log(`📝 ${userId} cược ${bet} ${amount} điểm`);
        socket.emit("bet_ok", { bet, amount });
    });

    socket.on("disconnect", () => {
        console.log("❌ Client disconnected:", socket.id);
        if (userId) {
            players.delete(userId);
            console.log("👤 Player out:", userId, "→", players.size);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🔥 Socket.IO Game server running at http://localhost:${PORT}`);
});

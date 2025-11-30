const express = require('express');
// const { generateCode } = require('verification-code-generator');
const sqlite = require('node:sqlite');
const path = require('path');
const nodemailer = require('nodemailer')
const app = express();
app.use(express.json());

function createVertify(length){
	let count = 0;
	let code = '';
	while(count<length){
		code += Math.floor(Math.random()*10);
		count++;
	}
	return code;
}

class VerificationCodeManager {
	constructor() {
		this.db = null;
		this.initDatabase();
	}

	async initDatabase() {
		// 初始化SQLite数据库
		this.db = new sqlite.DatabaseSync('./verification_codes.db');
		
		// 创建验证码存储表
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS verification_codes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT UNIQUE NOT NULL,
				code TEXT NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				expires_at DATETIME NOT NULL,
				used INTEGER DEFAULT 0
			)
		`);
		
		// 创建索引提高查询效率
		this.db.exec('CREATE INDEX IF NOT EXISTS idx_email ON verification_codes(email)');
		this.db.exec('CREATE INDEX IF NOT EXISTS idx_expires_at ON verification_codes(expires_at)');
	}

	// 生成并存储验证码
	async generateAndStoreCode(email) {
		const code = createVertify(6);
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10分钟过期
		
		// 使用预处理语句防止SQL注入
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO verification_codes (email, code, expires_at, used) 
			VALUES (?, ?, ?, 0)
		`);
		stmt.run(email, code, expiresAt.toISOString());
		return code;
	}

	// 验证验证码
	async verifyCode(email, code) {
		const stmt = this.db.prepare(`
			SELECT * FROM verification_codes 
			WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
		`);
		
		const record = stmt.get(email, code);
		
		if (record) {
			// 标记验证码为已使用
			const updateStmt = this.db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?');
			updateStmt.run(record.id);
			return true;
		}
		
		return false;
	}

	// 清理过期的验证码
	cleanupExpiredCodes() {
		this.db.exec("DELETE FROM verification_codes WHERE expires_at <= datetime('now')");
	}

	// 检查发送频率限制
	canSendCode(email) {
		const stmt = this.db.prepare(`
			SELECT COUNT(*) as count FROM verification_codes 
			WHERE email = ? AND created_at > datetime('now', '-1 minute')
		`);
		
		const result = stmt.get(email);
		return result.count < 3; // 1分钟内最多发送3次
	}
}

class QQEmailService{
	constructor() {
		this.config = {
			host: 'smtp.qq.com',
			port: 465,
			secure: true,
			auth: {
				user: '1304041493@qq.com',
				pass: 'xocljzwvlomyhief'
			}
		}
		this.transporter = nodemailer.createTransport(this.config);
		this.verifyConfig();
	}

	async verifyConfig(){
		try{
			await this.transporter.verify();
			console.log('SMTP连接配置正确');
		}catch(error){
			console.error('SMTP配置错误',error);
		}
	}

	async sendVerificationCode(email,code){
		const mailOptions = {
			from: {
				name: "系统验证服务",
				address: this.config.auth.user
			},
			to:email,
			subject: '登录验证码',
			html: this.generateEmailTemplate(code)
		};
		const result = await this.transporter.sendMail(mailOptions);
		console.log(`邮件发送成功${email},消息ID${result.messageId}`);
		return true;
	}

	generateEmailTemplate(code){
		return `
			<div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6; border-radius: 10px;">
				<div style="text-align: center; margin-bottom: 20px;">
					<h2 style="color: #12B7F5; margin: 0;">邮箱验证</h2>
				</div>
				
				<div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
					<p style="margin: 0 0 15px 0; color: #666;">您正在尝试登录系统，请使用以下验证码完成验证：</p>
					
					<div style="text-align: center; margin: 25px 0;">
						<div style="font-size: 32px; font-weight: bold; color: #12B7F5; letter-spacing: 8px; 
									background: #f0f8ff; padding: 15px; border-radius: 8px; border: 2px dashed #12B7F5;">
							${code}
						</div>
					</div>
					
					<p style="margin: 15px 0; color: #999; font-size: 14px;">
						<strong>温馨提示：</strong>
					</p>
					<ul style="margin: 0; padding-left: 20px; color: #999; font-size: 14px;">
						<li>此验证码 <strong style="color: #FF6B6B;">10分钟</strong> 内有效</li>
						<li>请勿将验证码透露给他人</li>
						<li>如非本人操作，请忽略此邮件</li>
					</ul>
				</div>
				
				<div style="text-align: center; color: #999; font-size: 12px; padding-top: 20px; border-top: 1px solid #e6e6e6;">
					<p>系统自动发送，请勿回复</p>
				</div>
			</div>
		`;
	}
}

// 初始化验证码管理器
const codeManager = new VerificationCodeManager();
const emailService = new QQEmailService();

app.use(express.static('.'));

app.get('/',(req,res)=>{
	res.sendFile(__dirname+'/index.html');
})


// 发送验证码接口
app.post('/api/send-verification-code', async (req, res) => {
	try {
		const { email } = req.body;
		
		if (!email) {
			return res.status(400).json({ 
				success: false, 
				message: '邮箱不能为空' 
			});
		}
		
		// 检查发送频率
		if (!codeManager.canSendCode(email)) {
			return res.status(429).json({
				success: false,
				message: '发送过于频繁，请稍后再试'
			});
		}
		
		// 生成验证码
		const code = await codeManager.generateAndStoreCode(email);
		
		// 这里调用您的邮件发送服务
		await emailService.sendVerificationCode(email, code);
		
		// 清理过期验证码
		// codeManager.cleanupExpiredCodes();
		
		console.log(`验证码 ${code} 已发送到: ${email}`);
		
		res.json({ 
			success: true, 
			message: '验证码已发送到您的邮箱' 
		});
		
	} catch (error) {
		console.error('发送验证码失败:', error);
		res.status(500).json({ 
			success: false, 
			message: '邮件发送失败，请稍后重试' 
		});
	}
});

// 验证验证码接口
app.post('/api/verify-code', (req, res) => {
	try {
		const { email, code } = req.body;
		
		if (!email || !code) {
			return res.status(400).json({ 
				success: false, 
				message: '邮箱和验证码不能为空' 
			});
		}
		
		const isValid = codeManager.verifyCode(email, code);
		
		if (isValid) {
			res.json({ 
				success: true, 
				message: '验证成功' 
			});
		} else {
			res.json({ 
				success: false, 
				message: '验证码错误或已过期' 
			});
		}
		
	} catch (error) {
		console.error('验证验证码失败:', error);
		res.status(500).json({ 
			success: false, 
			message: '验证失败，请重试' 
		});
	}
});

// 模拟邮件发送函数 - 替换为您的实际邮件服务
// async function sendVerificationEmail(email, code) {
// 	// 这里使用您选择的邮件服务（如Nodemailer、SendGrid等）
// 	console.log(`发送邮件到 ${email}，验证码: ${code}`);
	
// 	// 示例：使用Nodemailer发送邮件
// 	// const transporter = nodemailer.createTransport({ ... });
// 	// await transporter.sendMail({
// 	//     from: 'your-email@example.com',
// 	//     to: email,
// 	//     subject: '您的验证码',
// 	//     html: `您的验证码是: <b>${code}</b>，10分钟内有效`
// 	// });
// }

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`服务器运行在端口 ${PORT}`);
});
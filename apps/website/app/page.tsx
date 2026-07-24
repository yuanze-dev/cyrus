import Reveal from "./Reveal";

const useCases = [
	{
		size: "big",
		title: "小到一句话的修改",
		body: "改文案、调样式、修个小 bug——像吩咐同事一样随手交给它，几分钟后成果就躺在 PR 里等你。",
		vis: "chat",
	},
	{
		size: "big",
		title: "大到跨仓库的工程",
		body: "大任务它会自己拆解，多管齐下、逐个击破。你只需要在关键节点把关。",
		vis: "bars",
	},
	{
		size: "small",
		title: "讨论里长出来的需求",
		body: "飞书里聊着聊着聊出的点子，它会整理成正式任务记录下来，做完再回到原对话告诉你。",
		vis: "flow",
	},
	{
		size: "small",
		title: "越用越懂你们团队",
		body: "项目的约定、你的偏好，它都会记住，下一次做得更贴合。",
		vis: "learn",
	},
	{
		size: "small",
		title: "PR 里继续打磨",
		body: "在 Pull Request 评论里提意见，它看到就接着改，改到你满意为止。",
		vis: "pr",
	},
];

const stats = [
	{ num: "0", label: "行代码需要你亲自动手" },
	{ num: "6", label: "步流水线，它全走完" },
	{ num: "24h", label: "随时待命，随叫随到" },
];

const pipeline = [
	{ title: "听懂需求", body: "你只管说，它负责理解任务、规划做法。" },
	{
		title: "独立开工",
		body: "每个任务都有专属工作区，互不打扰，也不影响你手头的代码。",
	},
	{ title: "动手开发", body: "AI 工程师逐行实现，做到哪一步，你随时看得见。" },
	{ title: "自我质检", body: "自动运行测试与检查，不合格，不交付。" },
	{
		title: "提交成果",
		body: "整理成规范的提交记录和 Pull Request，等你评审。",
	},
	{ title: "主动汇报", body: "一做完就在飞书里通知你，附上当次成果说明。" },
];

const features = [
	{
		title: "独立工作区",
		body: "每个任务都在隔离的环境里进行，互不干扰，也不会碰乱你手头的代码。",
	},
	{
		title: "全程直播",
		body: "每一步思考和动作都实时写在任务时间线上——它怎么想的，你都看得见。",
	},
	{
		title: "你掌方向盘",
		body: "要不要合并，永远你说了算。它只提交成果，不替你做决定。",
	},
];

const integrations = [
	{
		name: "飞书",
		desc: "在任何对话里 @ 它，讨论直接变成 PR。",
	},
	{
		name: "Linear",
		desc: "把任务直接指派给它，或者打个标签就行。",
	},
	{
		name: "GitHub",
		desc: "它按你团队的方式提交 PR——接受评审意见和检查结果，直到通过。",
	},
	{
		name: "Claude × Codex",
		desc: "两位 AI 工程师坐镇，按任务自动选择最合适的那位。",
	},
];

const faqs = [
	{
		q: "需要懂编程才能用吗？",
		a: "不需要。提需求就像发消息，说清楚你想要什么就行。",
	},
	{
		q: "它会不会把我的代码改坏？",
		a: "每个任务都在独立工作区里进行，通过全部检查才会提交成果；是否合并，由你把关。",
	},
	{
		q: "它能做多大的事？",
		a: "从改一句文案、修一个 bug，到完成一个完整功能都可以。任务越大，越建议多给它一些背景说明。",
	},
	{
		q: "做完没人理我怎么办？",
		a: "不存在。它一完工就会主动在飞书里通知你。",
	},
];

function Vis({ kind }: { kind: string }) {
	switch (kind) {
		case "chat":
			return (
				<div className="vis vis-chat" aria-hidden="true">
					<span className="vb vb-user">把按钮改成圆角风格</span>
					<span className="vb vb-done">
						<i>✓</i> 已完成，PR 已提交
					</span>
				</div>
			);
		case "bars":
			return (
				<div className="vis vis-bars" aria-hidden="true">
					<span className="vbar b1" />
					<span className="vbar b2" />
					<span className="vbar b3" />
				</div>
			);
		case "flow":
			return (
				<div className="vis vis-flow" aria-hidden="true">
					<span className="vchip">飞书讨论</span>
					<span className="varrow">→</span>
					<span className="vchip accent">正式任务</span>
				</div>
			);
		case "learn":
			return (
				<div className="vis vis-learn" aria-hidden="true">
					<span className="vchip glow">已记住：你们的项目约定</span>
				</div>
			);
		case "pr":
			return (
				<div className="vis vis-pr" aria-hidden="true">
					<span className="vb vb-comment">“这里再收窄一点”</span>
					<span className="vb vb-done">
						<i>✓</i> 已更新
					</span>
				</div>
			);
		default:
			return null;
	}
}

export default function Home() {
	return (
		<>
			{/* ---------- 顶栏（Devin 风格固定栏） ---------- */}
			<header className="nav">
				<div className="nav-inner">
					<a className="brand" href="#top">
						{/* biome-ignore lint/performance/noImgElement: 静态导出站点直接使用原生 img */}
						<img
							className="brand-mark"
							src="/icon.png"
							alt=""
							width={24}
							height={24}
						/>
						<span className="brand-name">Xight</span>
					</a>
					<nav>
						<a href="#use-cases">它能做什么</a>
						<a href="#pipeline">工作流程</a>
						<a href="#integrations">集成</a>
						<a href="#faq">常见问题</a>
					</nav>
					<a className="nav-cta" href="#pipeline">
						开始使用
					</a>
				</div>
			</header>

			<main>
				{/* ---------- Hero ---------- */}
				<section className="hero">
					<div className="container hero-copy">
						<a className="hero-badge" href="#use-cases">
							<span className="hero-badge-tag">New</span>
							<span className="hero-badge-text">飞书对话派任务已上线</span>
							<svg
								width="14"
								height="14"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								aria-hidden="true"
							>
								<line x1="3.7" y1="10.4" x2="8.3" y2="5.8" />
								<polyline points="3.4,5.5 8.6,5.5 8.6,10.7" />
							</svg>
						</a>
						<h1>Xight，你的 AI 产研搭档</h1>
						<p className="hero-sub">
							在飞书或 Linear 里说一句话，它独立完成开发、自测、提交 Pull
							Request，做完了主动来叫你。
						</p>
						<div className="hero-actions">
							<a className="btn primary" href="#pipeline">
								看看它怎么工作
							</a>
							<a className="btn ghost" href="#use-cases">
								它能接哪些活
							</a>
						</div>
					</div>

					{/* Hero 主视觉：飞书对话演示 */}
					<div className="container hero-visual" aria-hidden="true">
						<div className="chat-card">
							<div className="chat-header">
								<span className="win-dot" />
								<span className="win-dot" />
								<span className="win-dot" />
								<span className="chat-title">飞书 · 产研讨论群</span>
							</div>
							<div className="chat-body">
								<div className="msg msg-user">
									@Xight 把落地页的主按钮改成圆角风格
								</div>
								<div className="msg msg-typing t1">
									<i />
									<i />
									<i />
								</div>
								<div className="msg msg-bot">
									收到，马上处理，完成后告诉你。
								</div>
								<div className="msg msg-typing t2">
									<i />
									<i />
									<i />
								</div>
								<div className="msg msg-done">
									<p className="done-title">
										<span className="check">✓</span> 已完成
									</p>
									<p className="done-body">
										修改已通过全部检查，Pull Request 提交好了。
									</p>
									<span className="done-chip">查看 PR</span>
								</div>
							</div>
						</div>
					</div>

					{/* 平台条 */}
					<div className="container platforms">
						<p className="platforms-caption">它就在你们每天用的工具里</p>
						<div className="platforms-row">
							<span className="platform">飞书</span>
							<span className="platform">Linear</span>
							<span className="platform">GitHub</span>
						</div>
					</div>
				</section>

				{/* ---------- 使用场景 bento ---------- */}
				<section id="use-cases" className="section">
					<div className="container">
						<Reveal>
							<h2>它能接的活，比你想的还多</h2>
							<p className="section-sub">从一句话的修改，到跨仓库的大工程。</p>
						</Reveal>
						<div className="bento">
							{useCases.map((u, i) => (
								<Reveal
									key={u.title}
									delay={i * 70}
									className={`bento-item ${u.size}`}
								>
									<div className="bento-card">
										<Vis kind={u.vis} />
										<h3>{u.title}</h3>
										<p>{u.body}</p>
									</div>
								</Reveal>
							))}
						</div>
					</div>
				</section>

				{/* ---------- 数字条 ---------- */}
				<section className="stats-strip">
					<div className="container stats">
						{stats.map((s) => (
							<div className="stat" key={s.label}>
								<span className="stat-num">{s.num}</span>
								<span className="stat-label">{s.label}</span>
							</div>
						))}
					</div>
				</section>

				{/* ---------- 产研流水线 ---------- */}
				<section id="pipeline" className="section">
					<div className="container">
						<Reveal>
							<h2>一条不用你操心的产研流水线</h2>
							<p className="section-sub">
								从一句话到可评审的代码，每一步它都替你走完。
							</p>
						</Reveal>
						<ol className="steps">
							{pipeline.map((s, i) => (
								<li className="step" key={s.title}>
									<span className="step-num">{i + 1}</span>
									<Reveal delay={i * 80} className="step-body">
										<h3>{s.title}</h3>
										<p>{s.body}</p>
									</Reveal>
								</li>
							))}
						</ol>
					</div>
				</section>

				{/* ---------- 特性三卡 ---------- */}
				<section className="section">
					<div className="container">
						<Reveal>
							<h2>过程透明，你始终在场</h2>
							<p className="section-sub">它替你干活，但知情权永远在你手里。</p>
						</Reveal>
						<div className="grid three">
							{features.map((f, i) => (
								<Reveal key={f.title} delay={i * 90}>
									<div className="card">
										<h3>{f.title}</h3>
										<p>{f.body}</p>
									</div>
								</Reveal>
							))}
						</div>
					</div>
				</section>

				{/* ---------- 集成 ---------- */}
				<section id="integrations" className="section">
					<div className="container">
						<Reveal>
							<h2>就在你们的工具里工作</h2>
							<p className="section-sub">
								不用迁移、不用学习新系统，无缝接入现有协作方式。
							</p>
						</Reveal>
						<div className="grid two">
							{integrations.map((it, i) => (
								<Reveal key={it.name} delay={i * 70}>
									<div className="card integration">
										<h3>{it.name}</h3>
										<p>{it.desc}</p>
									</div>
								</Reveal>
							))}
						</div>
					</div>
				</section>

				{/* ---------- FAQ ---------- */}
				<section id="faq" className="section">
					<div className="container narrow">
						<Reveal>
							<h2>常见问题</h2>
						</Reveal>
						<div className="faq-list">
							{faqs.map((f, i) => (
								<Reveal key={f.q} delay={i * 60}>
									<details className="faq">
										<summary>{f.q}</summary>
										<p>{f.a}</p>
									</details>
								</Reveal>
							))}
						</div>
					</div>
				</section>

				{/* ---------- CTA ---------- */}
				<section className="cta">
					<div className="container">
						<Reveal>
							<h2>把重复的开发交给它，把判断留给自己</h2>
							<a className="btn inverse" href="#top">
								回到顶部
							</a>
						</Reveal>
					</div>
				</section>
			</main>

			{/* ---------- Footer（Devin 风格宽 footer） ---------- */}
			<footer className="footer">
				<div className="container footer-top">
					<div className="footer-brand">
						<span className="brand-name">Xight</span>
						<p>AI 产研搭档</p>
					</div>
					<div className="footer-col">
						<h4>产品</h4>
						<a className="footer-link" href="#use-cases">
							它能做什么
						</a>
						<a className="footer-link" href="#pipeline">
							工作流程
						</a>
						<a className="footer-link" href="#integrations">
							集成
						</a>
					</div>
					<div className="footer-col">
						<h4>支持</h4>
						<a className="footer-link" href="#faq">
							常见问题
						</a>
						<a className="footer-link" href="#top">
							回到顶部
						</a>
					</div>
					<div className="footer-col">
						<h4>项目</h4>
						<a
							className="footer-link"
							href="https://github.com/yuanze-dev/cyrus"
							target="_blank"
							rel="noreferrer"
						>
							GitHub
						</a>
						<span className="footer-note">开源 · MIT License</span>
					</div>
				</div>
				<div className="container footer-bottom">
					<span>© 2026 Xight</span>
					<span className="footer-note">由 Claude 与 Codex 驱动</span>
				</div>
			</footer>
		</>
	);
}

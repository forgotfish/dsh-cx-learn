/**
 * dsh-cx-learn —— client 半端（设置页 UI）
 * ============================================================================
 * 注册到「设置 → 学习通看课」，通过 /api/cx-learn/* 与 host 通信。
 * 形状：总开关式的配置 + 扫码登录（二维码直接显示在页里）+ 启停 + 实时日志。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-cx-learn',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/cx-learn'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const extra = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + extra)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /**
     * 心跳年龄说人话。
     * null / 非数字 → 「—」（引擎还没写过 heartbeatAt，属正常，不是错误）
     */
    const ageText = (ms) => {
      if (ms === null || ms === undefined) return '—'
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return '—'
      if (n < 60 * 1000) return Math.round(n / 1000) + 's 前'
      if (n < 3600 * 1000) return Math.round(n / 60000) + ' 分钟前'
      return Math.round(n / 3600000) + ' 小时前'
    }

    const CSS = `
[data-cx-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:680px;}
[data-cx-card]{border:1px solid var(--dsw-alias-border-secondary,#e5e7eb);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
[data-cx-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);text-transform:uppercase;}
[data-cx-row]{display:flex;align-items:center;gap:10px;}
[data-cx-grow]{flex:1;min-width:0;}
[data-cx-label]{font-size:13px;color:var(--dsw-alias-label-primary,#111827);}
[data-cx-hint]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);line-height:1.5;}
[data-cx-in]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,#d1d5db);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:13px;font-family:inherit;}
[data-cx-in]:focus{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:-1px;}
[data-cx-btn]{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,#d1d5db);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:13px;cursor:pointer;font-family:inherit;}
[data-cx-btn]:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#f3f4f6);}
[data-cx-btn]:disabled{opacity:.5;cursor:not-allowed;}
[data-cx-btn][data-primary]{background:var(--dsw-alias-accent,#2563eb);color:#fff;border-color:transparent;}
[data-cx-btn][data-danger]{background:#dc2626;color:#fff;border-color:transparent;}
[data-cx-dot]{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
[data-cx-pre]{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-secondary,#f9fafb);font-size:11.5px;line-height:1.55;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary,#4b5563);}
[data-cx-qr]{width:100%;max-width:560px;height:auto;border:1px solid var(--dsw-alias-border-secondary,#e5e7eb);border-radius:8px;display:block;cursor:zoom-in;background:#fff;}
[data-cx-qr-full]{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;}
[data-cx-qr-full] img{max-width:92vw;max-height:88vh;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.4);image-rendering:auto;}
[data-cx-msg]{font-size:12.5px;padding:8px 10px;border-radius:8px;}
[data-cx-msg][data-ok]{background:#ecfdf5;color:#065f46;}
[data-cx-msg][data-err]{background:#fef2f2;color:#991b1b;}
[data-cx-group]{display:flex;align-items:center;gap:10px;padding:2px 2px 0;margin-top:2px;}
[data-cx-group]::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-secondary,#e5e7eb);}
[data-cx-group-title]{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;}
[data-cx-bad]{color:#dc2626;}
`

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [qr, setQr] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      // 扫码进度（提前声明：下面自动刷二维码的 effect 依赖它，
      // 晚声明会撞上 const 的 TDZ，Panel 直接抛 ReferenceError → 白屏）
      const [loginState, setLoginState] = React.useState('unknown')
      const [loginHint, setLoginHint] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [zoom, setZoom] = React.useState(false)
      const [url, setUrl] = React.useState('')
      const [mode, setMode] = React.useState('continue_chapters')
      const [maxSections, setMaxSections] = React.useState(5)
      const [browserId, setBrowserId] = React.useState('')
      const [chromiumPath, setChromiumPath] = React.useState('')
      const [questions, setQuestions] = React.useState([])
      const [draftText, setDraftText] = React.useState('')
      const [needLogin, setNeedLogin] = React.useState(false)
      const [courses, setCourses] = React.useState(null)
      const [loadingCourses, setLoadingCourses] = React.useState(false)
      const [dirty, setDirty] = React.useState(false)
      const [questionsOpen, setQuestionsOpen] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const s = await jget('/status')
          setSt(s)
          setQuestions(Array.isArray(s?.questions) ? s.questions : [])
          if (!dirty && s?.config) {
            setUrl(s.config.courseUrl || '')
            setMode(s.config.mode || 'continue_chapters')
            setMaxSections(Number(s.config.maxSections) || 5)
            setBrowserId(s.config.browserId || '')
            setChromiumPath(s.config.chromiumPath || '')
          }
        } catch (e) {
          setMsg({ kind: 'err', text: '读状态失败：' + e.message })
        }
      }, [dirty])

      React.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 3000)
        return () => clearInterval(t)
      }, [refresh])

      const save = async () => {
        setBusy('save')
        try {
          await jpost('/config', {
            courseUrl: url.trim(), mode, maxSections: Number(maxSections) || 5,
            browserId, chromiumPath: chromiumPath.trim(),
          })
          setDirty(false)
          setMsg({ kind: 'ok', text: '配置已保存' })
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + e.message })
        } finally { setBusy('') }
      }

      const doStart = async () => {
        setBusy('start')
        try {
          await jpost('/config', {
            courseUrl: url.trim(), mode, maxSections: Number(maxSections) || 5,
            browserId, chromiumPath: chromiumPath.trim(),
          })
          setDirty(false)
          // 每次开跑前先校验登录态：失效就明确提示扫码，避免跑到一半才 LOGIN_REQUIRED
          setMsg({ kind: 'ok', text: '正在校验登录态…' })
          const r = await jpost('/start-precheck', {})
          if (!r.ok) {
            setMsg({ kind: 'err', text: r.error || '启动失败' })
            if (r.needLogin) setNeedLogin(true)
          } else {
            setNeedLogin(false)
            setMsg({ kind: 'ok', text: '登录态有效，已启动（pid ' + r.pid + '）' })
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: '启动失败：' + e.message })
        } finally { setBusy('') }
      }

      const draftQuestion = async (id) => {
        setBusy('draft-' + id)
        try {
          const r = await jpost('/questions/' + encodeURIComponent(id) + '/draft', {})
          if (!r.ok) { setMsg({ kind: 'err', text: r.error || '生成草稿失败' }); return }
          const target = questions.find((q) => q.id === id)
          if (target) setQuestions(questions.map((q) => q.id === id ? { ...q, status: 'drafted', draftedAt: new Date().toISOString() } : q))
          // 队列是唯一事实来源；事件只负责通知已挂载的 composer 桥接。
          window.__cxLearnDraftQueue = window.__cxLearnDraftQueue || []
          const item = { id, text: r.draft, submitted: false }
          if (!window.__cxLearnDraftQueue.some((x) => x && x.id === id)) window.__cxLearnDraftQueue.push(item)
          window.dispatchEvent(new CustomEvent('cx-learn-draft', { detail: item }))
          // 降级路径：当前 DSH 没有 composer 插槽时，直接给出可复制的草稿文本。
          if (!window.__cxLearnComposerReady) {
            setDraftText(r.draft)
            setMsg({ kind: 'ok', text: '当前 DSH 没有 composer 插槽，草稿已写入下方文本框，点「复制草稿」后自行粘贴发送。' })
          } else {
            setMsg({ kind: 'ok', text: '草稿已投递到对话框输入框，请自行确认并发送，插件不会自动发送。' })
          }
        } catch (e) {
          setMsg({ kind: 'err', text: '生成草稿失败：' + e.message })
        } finally { setBusy('') }
      }

      const copyDraft = async () => {
        if (!draftText) return
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(draftText)
            setMsg({ kind: 'ok', text: '草稿已复制到剪贴板。' })
            return
          }
        } catch (_) { /* 回退到 execCommand */ }
        try {
          const ta = document.createElement('textarea')
          ta.value = draftText
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand && document.execCommand('copy')
          ta.remove()
          setMsg(ok ? { kind: 'ok', text: '草稿已复制到剪贴板。' } : { kind: 'err', text: '复制失败，请手动选中文本框内容复制。' })
        } catch (e) {
          setMsg({ kind: 'err', text: '复制失败：' + e.message })
        }
      }

      const doStop = async () => {
        setBusy('stop')
        try {
          const r = await jpost('/stop', {})
          setMsg(r.ok ? { kind: 'ok', text: '已发送停止信号' } : { kind: 'err', text: r.error })
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: '停止失败：' + e.message })
        } finally { setBusy('') }
      }

      /**
       * ★ B-精简：结束会话。
       * 和「停止」的区别：
       *   停止   = 停当前这一轮看课，会话还在，可以接着刷下一门
       *   结束会话 = 关浏览器 + 销毁登录态，下次必须重新扫码
       * 刷完了、或者想立刻释放内存时点它。
       */
      const doEndSession = async () => {
        setBusy('endsession')
        try {
          const r = await jpost('/session/end', {})
          if (r.ok) {
            const extra = r.killed ? '（已关闭浏览器）' : '（没有发现运行中的浏览器）'
            setMsg({ kind: 'ok', text: '会话已结束 ' + extra + '，下次看课需要重新扫码。' })
          } else {
            setMsg({ kind: 'err', text: r.error || '结束会话失败' })
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: '结束会话失败：' + e.message })
        } finally { setBusy('') }
      }

      /**
       * 只清本插件自己的内核进程（后端只按临时 profile 标记匹配）。
       * 不重启 DSH 服务，也不碰其它 Chrome。
       */
      const doRestartKernel = async () => {
        setBusy('restart')
        try {
          const r = await jpost('/browser/restart', {})
          if (r.ok) {
            setMsg({
              kind: 'ok',
              text: r.killed ? '已清理本插件的内核进程，状态文件已重置' : '没有发现残留内核；状态已重置',
            })
          } else {
            setMsg({ kind: 'err', text: r.error || '重启内核失败' })
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'err', text: '重启内核失败：' + e.message })
        } finally { setBusy('') }
      }

      const doLogin = async () => {
        setBusy('login')
        try {
          const r = await jpost('/login', {})
          if (!r.ok) { setMsg({ kind: 'err', text: r.error }); return }
          setMsg({ kind: 'ok', text: r.hint || '登录进程已启动' })
        } catch (e) {
          setMsg({ kind: 'err', text: '登录启动失败：' + e.message })
        } finally { setBusy('') }
      }

      const doQr = async () => {
        setBusy('qr')
        try {
          /* ★ 2026-10-30 修：原来只调 /qr，那只是把**旧截图**重读一遍，
             不会让浏览器换码。用户点了很多次看到的还是同一张「已失效」的图，
             体感就是「按钮没反应」。现在调 /qr/refresh：后端写刷新请求，
             引擎点页面上的「重新获取」，再返回新图。 */
          const r = await jpost('/qr/refresh', {})
          if (!r.ok) { setMsg({ kind: 'err', text: r.error || '换码失败' }); return }
          setQr(r)
          setMsg({ kind: 'ok', text: '已重新获取二维码，请用学习通 App 扫新码' })
        } catch (e) {
          setMsg({ kind: 'err', text: '取二维码失败：' + e.message })
        } finally { setBusy('') }
      }

      /* 等待扫码期间自动刷二维码：超星扫码会话只活 ~60 秒，界面上的码过时就废了。
         每 4 秒取一次最新代，保证「对着屏幕扫」手里永远是活码。 */
      React.useEffect(() => {
        if (loginState !== 'waiting') return
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const r = await jget('/qr')
            if (!stop && r && r.ok) setQr(r)
          } catch { /* ignore */ }
        }
        tick()
        const t = setInterval(tick, 4000)
        return () => { stop = true; clearInterval(t) }
      }, [loginState])

      const doLoadCourses = async (silent) => {
        setLoadingCourses(true)
        try {
          const r = await jget('/courses')
          if (!r.ok) {
            setCourses(null)
            setMsg({ kind: 'err', text: (r.error || '读取失败') + (r.needLogin ? '，请先扫码登录' : '') })
            return
          }
          setCourses(r.courses || [])
          setMsg({ kind: 'ok', text: '读到 ' + (r.count || 0) + ' 门课，请在下方选择' })
        } catch (e) {
          if (!silent) setMsg({ kind: 'err', text: '读取课程失败：' + e.message })
        } finally { setLoadingCourses(false) }
      }

      /* 扫码登录成功检测：轮询 /login-state，成功后提示 + 自动拉课程。
         之前没有这一步，扫完码界面毫无变化，不知道成功没有，也找不到「读取我的课程」。 */
      const autoLoadedRef = React.useRef(false)
      React.useEffect(() => {
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const r = await jget('/login-state')
            if (stop || !r || !r.ok) return
            setLoginState(r.state || 'unknown')
            setLoginHint(r.hint || '')
            if (r.state === 'logged_in' && !autoLoadedRef.current) {
              autoLoadedRef.current = true
              setMsg({ kind: 'ok', text: '✅ 登录成功！正在读取你的课程…' })
              await doLoadCourses(true)
            }
          } catch { /* 忽略单次失败 */ }
        }
        tick()
        const t = setInterval(tick, 4000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      const pickCourse = (cid) => {
        const c = (courses || []).find((x) => x.courseId === cid)
        if (!c) return        // 用课程列表里的原始完整链接（含 clazzid / cpi / ismooc2 等），
        // 自己拼 studentstudy?courseId=... 会因为缺 enc 打开不了课程页。
        const u = c.href || ('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=' + c.courseId +
          (c.clazzid ? '&clazzid=' + c.clazzid : '') +
          (c.enc ? '&enc=' + c.enc : ''))
        setUrl(u)
        setDirty(true)
        setMsg({ kind: 'ok', text: '已选课程 ' + (c.title ? c.title.slice(0, 20) : c.courseId) + '，点「保存配置」生效' })
      }

      const runningFlag = !!st?.running
      const envOk = st?.engineReady && st?.chromiumReady
      /* ★ B-精简：会话是否可用。后端返回 null 表示「从没开过会话」，不是错误。 */
      const sess = st?.session || null
      const sessionActive = !!(sess && sess.active && sess.loginVerified)
      const browserList = st?.browsers || []

      /* ★ 内核健康行：全部字段都可能缺失（引擎比插件旧时 browser 为 null），
         缺一个就显示「—」，绝不拼出 "undefined" 或整行消失。 */
      const br = st?.browser || null
      const browserBad = !!br && br.alive === false
      const kernelLine = (() => {
        if (!br) return '内核：—'
        const parts = ['内核：' + (br.alive === true ? '就绪' : br.alive === false ? '已停止' : '—')]
        if (br.pid) parts.push('pid ' + br.pid)
        parts.push('CDP ' + (br.port ?? '—'))
        parts.push('心跳 ' + ageText(br.ageMs !== undefined && br.ageMs !== null
          ? br.ageMs
          : (br.heartbeatAt ? Date.now() - Date.parse(br.heartbeatAt) : null)))
        if (br.restarts) parts.push('重启 ' + br.restarts + ' 次')
        if (br.lastErrorKind) parts.push(br.lastErrorKind)
        return parts.join(' · ')
      })()

      return h('div', { 'data-cx-page': '' },

        /* ══ 浏览器环境 ══
           内核、健康、会话都在这一屏：出问题时先看这里，不用往下翻。
           课程相关的东西一律放在「课程业务」，两块不混。 */
        h('div', { 'data-cx-group': '' }, h('span', { 'data-cx-group-title': '' }, '浏览器环境')),

        // 状态卡
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-row': '' },
            h('span', {
              'data-cx-dot': '',
              style: { background: runningFlag ? '#16a34a' : (envOk ? '#9ca3af' : '#ef4444') },
            }),
            h('span', { 'data-cx-label': '', 'data-cx-grow': '' },
              runningFlag ? '运行中' + (st?.pid ? '（pid ' + st.pid + '）' : '') : (envOk ? '空闲' : '环境未就绪')),
            h('button', { 'data-cx-btn': '', onClick: refresh, disabled: busy !== '' }, '刷新')),
          h('div', { 'data-cx-hint': '' },
            '引擎：' + (st?.engineReady ? '就绪' : '缺失') +
            ' · 内核：' + (st?.chromiumReady ? '就绪' : '未找到') +
            ' · 数据目录：' + (st?.home || '')),
          /* ★ 2026-10-30：内核健康行。数据来自 engine/.state/browser.json（浏览器层写），
             字段可能还没有（引擎版本比插件旧）→ 一律显示「—」，不报错、不留空白。 */
          h('div', { 'data-cx-hint': '', 'data-cx-bad': browserBad ? '' : undefined },
            kernelLine),
          h('div', { 'data-cx-hint': '' },
            '题目处理：安全识别后暂停，不自动答题或提交' +
            ' · 当前内核：' + (st?.chromium || '-')),
          st?.state?.startedAt
            ? h('div', { 'data-cx-hint': '' },
                '上次启动 ' + new Date(st.state.startedAt).toLocaleString() +
                ' · 模式 ' + (st.state.mode || '-') +
                ' · 上限 ' + (st.state.maxSections || '-') + ' 节')
            : null),

        // 内核选择卡
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-h': '' }, '浏览器内核'),
          h('div', { 'data-cx-row': '' },
            h('span', { 'data-cx-label': '', style: { width: 72 } }, '使用内核'),
            h('select', {
              'data-cx-in': '',
              value: chromiumPath.trim() ? '__custom__' : (browserId || '__auto__'),
              onChange: (e) => {
                const v = e.target.value
                if (v === '__custom__') { setChromiumPath(chromiumPath || '/usr/bin/chromium'); }
                else { setBrowserId(v === '__auto__' ? '' : v); setChromiumPath('') }
                setDirty(true)
              },
              style: { flex: 1 },
            },
              h('option', { value: '__auto__' }, '自动（优先共享区，其次系统）'),
              browserList.map((b) => h('option', { key: b.id, value: b.id }, b.label)),
              h('option', { value: '__custom__' }, '自定义路径…')),
            ),
          chromiumPath.trim()
            ? h('div', { 'data-cx-row': '' },
                h('span', { 'data-cx-label': '', style: { width: 72 } }, '内核路径'),
                h('input', {
                  'data-cx-in': '',
                  'data-cx-grow': '',
                  placeholder: '/绝对路径/chrome',
                  value: chromiumPath,
                  onChange: (e) => { setChromiumPath(e.target.value); setDirty(true) },
                }))
            : null,
          h('div', { 'data-cx-hint': '' },
            '内核目录：' + (st?.browserRoot || '未探测到') +
            '。换机器时把内核丢进这个目录就能在这里直接选，不用改插件。'),
          h('div', { 'data-cx-row': '' },
            h('button', {
              'data-cx-btn': '',
              onClick: doRestartKernel,
              disabled: busy !== '' || runningFlag,
              title: '只清本插件自己的内核进程（临时 profile），不碰其它 Chrome',
            }, busy === 'restart' ? '重启中…' : '重启内核'),
            h('span', { 'data-cx-hint': '', 'data-cx-grow': '' },
              '内核卡死或端口占用时用；不会影响学习通账号，也不影响其它浏览器。'),
          )),

        // 会话卡：登录会话属于浏览器层，和内核放一起
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-h': '' }, '登录会话'),
          /* 会话状态：告诉用户「现在这个登录还能用多久、内核在哪」 */
          sessionActive
            ? h('div', { 'data-cx-hint': '' },
                '会话进行中：内核 pid ' + (sess?.kernelPid ?? '—') + ' · 端口 ' + (sess?.port ?? '—') +
                ' · 最后使用 ' + (sess?.lastUsedAt ? new Date(sess.lastUsedAt).toLocaleTimeString() : '—') +
                ' · 闲置 ' + Math.round((sess?.keepAliveMs || 0) / 60000) + ' 分钟后自动结束')
            : h('div', { 'data-cx-hint': '' },
                '一次性登录：会话结束（或闲置超时）后登录态即销毁，下次需重新扫码。'),
          h('div', { 'data-cx-row': '' },
            /* ★ B-精简：会话期间浏览器一直活着。刷完了点这个，立刻释放内存。 */
            h('button', {
              'data-cx-btn': '',
              'data-danger': '',
              onClick: doEndSession,
              disabled: busy !== '' || runningFlag || !sessionActive,
              title: '关闭浏览器并销毁登录态。不点也会在闲置超时后自动结束。',
            }, busy === 'endsession' ? '结束中…' : '结束会话'),
            h('span', { 'data-cx-hint': '', 'data-cx-grow': '' },
              '会话期间浏览器不关；结束会话 = 关内核 + 销毁登录态，下次看课要重新扫码。')),
          h('div', { 'data-cx-hint': '' },
            '会话内可以「读课程 → 看课 → 换一门课 → 再看课」，不用重复扫码。')),

        /* ══ 课程业务 ══ */
        h('div', { 'data-cx-group': '' }, h('span', { 'data-cx-group-title': '' }, '课程业务')),

        // 扫码登录
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-h': '' }, '扫码登录'),
          needLogin
            ? h('div', { 'data-cx-msg': '', 'data-err': '', style: { marginBottom: '8px' } },
                '登录态已失效，请点「开始登录」重新扫码；扫完再点「开始看课」。')
            : null,
          /* 登录进度：由 /login-state 轮询驱动，扫完码在这里直接看到结果 */
          loginState === 'waiting'
            ? h('div', { 'data-cx-msg': '', 'data-ok': '', style: { marginBottom: '8px' } },
                '⏳ 等待扫码… 请用学习通 App 扫下方二维码，手机上确认后这里会显示「登录成功」')
            : loginState === 'logged_in'
              ? h('div', { 'data-cx-msg': '', 'data-ok': '', style: { marginBottom: '8px' } },
                  '✅ ' + (loginHint || '登录成功') + ' —— 会话进行中，可以连续刷多门课，不用重扫')
              : loginState === 'timeout' || loginState === 'stale'
                ? h('div', { 'data-cx-msg': '', 'data-err': '', style: { marginBottom: '8px' } },
                    '❌ ' + (loginHint || '登录未完成') + ' —— 请重新点「开始登录」扫码')
                : null,
          h('div', { 'data-cx-row': '' },
            h('button', { 'data-cx-btn': '', 'data-primary': '', onClick: doLogin, disabled: busy !== '' || runningFlag }, '开始登录'),
            h('button', { 'data-cx-btn': '', onClick: doQr, disabled: busy !== '' }, '刷新二维码')),
          h('div', { 'data-cx-hint': '' },
            '扫码成功后自动读取课程；登录态的有效期与内核看「浏览器环境 · 登录会话」。'),
          qr?.ok
            ? h('div', { 'data-cx-col': '', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('img', {
                  'data-cx-qr': '',
                  src: qr.dataUrl,
                  alt: '登录二维码',
                  title: '点一下看大图',
                  onClick: () => setZoom(true),
                }),
                h('div', { 'data-cx-hint': '' },
                  '扫码有效期约 2 分钟。' + (qr.mtime ? '（生成于 ' + new Date(qr.mtime).toLocaleTimeString() + '）' : '') +
                  ' · 点图片可以放大',
                ),
                zoom
                  ? h('div', { 'data-cx-qr-full': '', onClick: () => setZoom(false) },
                      h('img', { src: qr.dataUrl, alt: '登录二维码大图' }))
                  : null)
            : null),

        // 课程设置
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-h': '' }, '课程设置'),
          h('div', { 'data-cx-hint': '' },
            '课程地址在学习通「课程 → 学习 → 任务点」页面地址栏里。'),
          h('div', { 'data-cx-row': '' },
            h('button', {
              'data-cx-btn': '',
              onClick: doLoadCourses,
              disabled: loadingCourses || !!st?.running,
            }, loadingCourses ? '读取中…' : '读取我的课程'),
            courses && courses.length
              ? h('select', {
                  'data-cx-in': '',
                  onChange: (e) => pickCourse(e.target.value),
                  defaultValue: '',
                  style: { flex: 1 },
                },
                  h('option', { value: '' }, '选择课程…'),
                  courses.map((c) => h('option', { key: c.courseId, value: c.courseId },
                    (c.title ? c.title.slice(0, 42) : '课程 ' + c.courseId) +
                    ' · ' + c.courseId + (c.clazzid ? ' · ' + c.clazzid : ''))))
              : h('span', { 'data-cx-hint': '' }, '先点「读取我的课程」，会自动列出你账号下的课')),
          h('div', { 'data-cx-row': '' },
            h('span', { 'data-cx-label': '', style: { width: 72 } }, '课程地址'),
            h('input', {
              'data-cx-in': '',
              'data-cx-grow': '',
              placeholder: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=...&clazzid=...&enc=...',
              value: url,
              onChange: (e) => { setUrl(e.target.value); setDirty(true) },
            })),
          h('div', { 'data-cx-row': '' },
            h('span', { 'data-cx-label': '', style: { width: 72 } }, '播放模式'),
            h('select', {
              'data-cx-in': '',
              value: mode,
              onChange: (e) => { setMode(e.target.value); setDirty(true) },
              style: { flex: 1 },
            },
              h('option', { value: 'continue_chapters' }, '章节连播（看完自动下一节）'),
              h('option', { value: 'current_chapter' }, '只跑当前章节')),
            h('span', { 'data-cx-label': '', style: { width: 96 } }, '每轮最多新看'),
            h('input', {
              'data-cx-in': '',
              type: 'number', min: 1, max: 200,
              value: maxSections,
              onChange: (e) => { setMaxSections(e.target.value); setDirty(true) },
              style: { width: 72 },
            }),
            h('span', { 'data-cx-hint': '' }, '节')),
          h('div', { 'data-cx-hint': '' },
            '视频内随堂题：按选项顺序盲试，答错换下一个，直到答对（不计入课程成绩）。'),
          h('div', { 'data-cx-hint': '' },
            '章节测验/作业：只识别、记录，绝不作答或提交；视频看完后直接跳到下一节继续看。'),
          h('div', { 'data-cx-hint': '' },
            '答错且被要求回看、或剩余次数用尽时，会立即停止盲试，不会硬试。'),
          h('div', { 'data-cx-row': '' },
            h('button', { 'data-cx-btn': '', 'data-primary': '', onClick: save, disabled: busy !== '' || !dirty }, '保存配置'),
            h('button', { 'data-cx-btn': '', onClick: () => { setDirty(false); refresh() }, disabled: !dirty }, '撤销改动'))),

        // 运行控制
        h('div', { 'data-cx-card': '' },
          h('div', { 'data-cx-h': '' }, '运行控制'),
          h('div', { 'data-cx-row': '' },
            h('button', {
              'data-cx-btn': '', 'data-primary': '',
              onClick: doStart, disabled: busy !== '' || runningFlag || !url.trim(),
            }, '开始看课'),
            h('button', { 'data-cx-btn': '', 'data-danger': '', onClick: doStop, disabled: busy !== '' || !runningFlag }, '停止')),
          h('div', { 'data-cx-hint': '' },
            '运行日志写在 ' + (st?.home || '...') + '/run.log，插件会保留最近一次的输出。')),

        // 待处理题目：识别后停在队列里，由用户逐条投递到对话框草稿。题目多于 3 条时默认折叠。
        questions.length
          ? h('div', { 'data-cx-card': '' },
              h('div', { 'data-cx-row': '' },
                h('div', { 'data-cx-h': '', 'data-cx-grow': '' }, '待处理题目（' + questions.length + '）'),
                questions.length > 3
                  ? h('button', {
                      'data-cx-btn': '',
                      onClick: () => setQuestionsOpen(!questionsOpen),
                    }, questionsOpen ? '收起' : '展开')
                  : null),
              !questions || questions.length <= 3 || questionsOpen
                ? h('div', { 'data-cx-hint': '' }, '只识别，不回答、不填空、不提交。点击“投递草稿”后，内容仅写入当前对话框输入框；若当前 DSH 没有 composer 插槽，则写入下方文本框供复制。')
                : h('div', { 'data-cx-hint': '' },
                    '已折叠 ' + questions.length + ' 条。最近：' + questions.slice(-2).map((q) => (q.question || '未读到题干').slice(0, 40)).join(' / ')),
              (!questions || questions.length <= 3 || questionsOpen)
                ? h('div', { style: { maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 } },
                    questions.map((q) => h('div', { key: q.id, 'data-cx-row': '', style: { alignItems: 'flex-start' } },
                      h('div', { 'data-cx-grow': '' },
                        h('div', { 'data-cx-label': '' }, q.kind === 'video_embedded_quiz' ? '视频内随堂题' : q.kind === 'chapter_work' ? '章节测验' : '待确认题目'),
                        h('div', { 'data-cx-hint': '' }, (q.question || '未读到题干').slice(0, 180)),
                        q.chapterTitle ? h('div', { 'data-cx-hint': '' }, '来源：' + q.chapterTitle) : null),
                      h('button', {
                        'data-cx-btn': '',
                        onClick: () => draftQuestion(q.id),
                        disabled: busy !== '' || q.status === 'drafted',
                      }, q.status === 'drafted' ? '已投递草稿' : '投递草稿'))))
                : null,
              // 降级草稿区：composer 插槽不可用时仍能把草稿交到用户手上。
              draftText
                ? h('div', { 'data-cx-row': '', style: { alignItems: 'flex-start', marginTop: '8px' } },
                    h('textarea', {
                      'data-cx-in': '',
                      readOnly: true,
                      value: draftText,
                      rows: 10,
                      style: { flex: 1, fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' },
                    }),
                    h('button', { 'data-cx-btn': '', onClick: copyDraft }, '复制草稿'))
                : null)
          : null,

        msg ? h('div', { 'data-cx-msg': '', 'data-ok': msg.kind === 'ok' ? '' : undefined, 'data-err': msg.kind === 'err' ? '' : undefined }, msg.text) : null,

        st?.logTail
          ? h('div', { 'data-cx-card': '' },
              h('div', { 'data-cx-h': '' }, '最近日志'),
              h('pre', { 'data-cx-pre': '' }, st.logTail))
          : null,
      )
    }

    function DraftBridge(props) {
      const inputActions = props && props.inputActions
      React.useEffect(() => {
        const canDraft = !!(inputActions && typeof inputActions.setDraft === 'function')
        window.__cxLearnComposerReady = canDraft
        if (!canDraft) return
        const delivered = window.__cxLearnDraftDelivered instanceof Set
          ? window.__cxLearnDraftDelivered
          : (window.__cxLearnDraftDelivered = new Set())
        const deliver = (item) => {
          if (!item || !item.id || !item.text || delivered.has(item.id)) return
          delivered.add(item.id)
          // 仅写入 composer 草稿；这里严禁调用 submit/send。
          inputActions.setDraft(item.text)
        }
        const onDraft = (event) => deliver(event && event.detail)
        window.addEventListener('cx-learn-draft', onDraft)
        const pending = window.__cxLearnDraftQueue || []
        while (pending.length) deliver(pending.shift())
        return () => window.removeEventListener('cx-learn-draft', onDraft)
      }, [inputActions])
      return null
    }

    return {
      // 只硬依赖 slots：composer 插槽在部分 DSH 版本不存在，若写进 inject 会让整个插件
      // 永远 pending（设置页都打不开），因此改为运行时探测。
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-cx-learn')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-cx-learn: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'cx-learn', order: 41, label: '学习通看课' },
          () => h(Panel),
        ))
        // composer 插槽只接收 inputActions.setDraft；绝不调用 submit。
        // 该插槽/服务可能不存在（例如 DSH 0.2.0-rc.2），此时静默降级到面板内复制。
        try {
          const conversation = typeof ctx.get === 'function' ? ctx.get('@deepseek-ai/dsh-client-ui-conversation') : undefined
          if (conversation || typeof slots.inject === 'function') {
            slots.inject('conversation.input.right', () => slots.register(
              { name: 'conversation.input.right', id: 'cx-learn-draft-bridge', order: 41 },
              (props) => h(DraftBridge, props || {}),
            ))
          }
        } catch (e) {
          // 没有该插槽时忽略：面板仍有「复制草稿」降级路径。
          window.__cxLearnComposerReason = String((e && e.message) || e)
        }
      },
    }
  },
})

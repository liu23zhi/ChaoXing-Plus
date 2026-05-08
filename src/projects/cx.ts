import md5 from 'md5';
import Typr from 'typr.js';
import {
  createDefaultQuestionResolver,
  defaultAnswerWrapperHandler,
  domSearch,
  OCSWorker,
  request,
  type SearchInformation,
  type SimplifyWorkResult
} from '../core/index.js';
import { Project, $gm } from '../runtime/index.js';
import { $message } from '../runtime/message.js';
import { sleep } from '../runtime/dom.js';
import { commonWork, enableCopy, playMedia } from '../utils/index.js';
import { playbackRate, volume } from '../utils/configs.js';
import { waitForElement, waitForMedia } from '../utils/study.js';
import {
  answerWrapperEmptyWarning,
  optimizationElementWithImage,
  removeRedundantWords,
  simplifyWorkResult,
  splitAnswer
} from '../utils/work.js';
import { $console } from './background.js';
import { CommonProject, type CommonWorkOptions } from './common.js';
import { resolveStudyAutomationFlags } from './study-panel-state.js';
import { resolveManualAnswerState } from './cx-manual-state.js';

let topWindow: Window = window.top ?? window;

try {
  const unsafeTop = topWindow as Window & Record<string, any>;
  unsafeTop.typrMapping = unsafeTop.typrMapping || undefined;
  unsafeTop.jobs = unsafeTop.jobs || [];
  unsafeTop.currentMedia = unsafeTop.currentMedia || undefined;
} catch {
  // ignore cross-origin init failures
}

const state = {
  study: {
    videojs: undefined as HTMLElement | undefined,
    hacked: false,
    answererWrapperUnsetMessage: undefined as unknown,
    playbackRateWarningListenerId: 0
  }
};

const TOP_CENTER_NOTICE_ID = 'cx-plus-top-center-notice';

function showTopCenterNotice(
  content: string,
  options: { duration?: number; tone?: 'info' | 'success' | 'warning' | 'error' } = {}
) {
  const duration = options.duration ?? 5000;
  const tone = options.tone ?? 'info';

  let targetDocument = document;
  try {
    targetDocument = (window.top ?? window).document;
  } catch {
    targetDocument = topWindow?.document ?? document;
  }

  targetDocument.getElementById(TOP_CENTER_NOTICE_ID)?.remove();

  const overlay = targetDocument.createElement('div');
  overlay.id = TOP_CENTER_NOTICE_ID;
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.zIndex = '2147483647';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.pointerEvents = 'none';
  overlay.style.padding = '24px';
  overlay.style.boxSizing = 'border-box';

  const card = targetDocument.createElement('div');
  card.textContent = content;
  card.style.maxWidth = 'min(560px, calc(100vw - 48px))';
  card.style.padding = '18px 24px';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(255,255,255,0.98)';
  card.style.boxShadow = '0 18px 48px rgba(0,0,0,0.2)';
  card.style.border = '1px solid rgba(0,0,0,0.08)';
  card.style.fontSize = '18px';
  card.style.lineHeight = '1.6';
  card.style.fontWeight = '600';
  card.style.textAlign = 'center';
  card.style.wordBreak = 'break-word';
  card.style.color =
    tone === 'success' ? '#135200' : tone === 'warning' ? '#8a5a00' : tone === 'error' ? '#a61d24' : '#1f1f1f';

  overlay.append(card);
  (targetDocument.body || targetDocument.documentElement).appendChild(overlay);

  if (duration > 0) {
    targetDocument.defaultView?.setTimeout(() => {
      overlay.remove();
    }, duration);
  }
}

export type VideoQuizStrategy = 'random' | 'ignore';
export type StudyMode = 'next' | 'job' | 'manually';

export type StudyOptions = {
  playbackRate: number;
  volume: number;
  muteMedia: boolean;
  videoQuizStrategy: VideoQuizStrategy;
  mode: StudyMode;
  restudy: boolean;
  forceLearn: boolean;
  backToFirstWhenFinish: boolean;
  enableMedia: boolean;
  enablePPT: boolean;
  enableAnswer: boolean;
  enableChapterTest: boolean;
  enableHyperlink: boolean;
  notifyWhenHasFaceRecognition: boolean;
  workOptions: CommonWorkOptions;
};

export type Attachment = {
  isPassed: boolean | undefined;
  job: boolean | undefined;
  jobid?: string;
  property: {
    mid: string;
    _jobid: string;
    module: 'insertbook' | 'insertdoc' | 'insertflash' | 'work' | 'insertaudio' | 'insertvideo';
    name?: string;
    author?: string;
    bookname?: string;
    publisher?: string;
    title?: string;
  };
};

export type Job = {
  mid: string;
  attachment: Attachment;
  func: (() => Promise<void>) | undefined;
};

const defaultWorkOptions: CommonWorkOptions = {
  period: 3,
  thread: 1,
  upload: 'save',
  answererWrappers: [],
  stopSecondWhenFinish: 3,
  redundanceWordsText: '',
  answerSeparators: '#,|,;,；',
  answerMatchMode: 'includes'
};

function settingsMethods() {
  return (CommonProject.scripts.settings.methods?.call({} as any) ?? {}) as {
    getWorkOptions?: () => CommonWorkOptions;
    notificationBySetting?: (content: string) => void;
  };
}

function renderMethods() {
  return (CommonProject.scripts.render.methods?.call({} as any) ?? {}) as {
    pin?: (script?: unknown) => void;
    normal?: () => void;
    minimize?: () => void;
  };
}

function appsMethods() {
  return (CommonProject.scripts.apps.methods?.call({} as any) ?? {}) as {
    searchAnswerInCaches?: <T>(title: string, provider: () => Promise<T>) => Promise<T>;
    addQuestionCacheFromWorkResult?: (result: unknown) => void;
  };
}

function workResultsMethods() {
  return (CommonProject.scripts.workResults.methods?.call({} as any) ?? {}) as {
    init?: (opts?: { questionPositionSyncHandlerType?: 'cx' }) => void;
    setResults?: (results: unknown) => void;
    appendResults?: (results: unknown) => void;
    updateWorkStateByResults?: (results: unknown) => void;
    patchResult?: (index: number, patch: Partial<SimplifyWorkResult>) => void;
    getResults?: () => SimplifyWorkResult[];
    setRuntimeControls?: (controls: {
      isRunning: () => boolean;
      isStopped: () => boolean;
      stop: () => void;
      continuate: () => void;
      retryQuestion: (index: number) => Promise<SimplifyWorkResult | undefined>;
      canRetryQuestion?: (index: number) => boolean;
    }) => void;
    clearRuntimeControls?: () => void;
    createWorkResultsPanel?: () => HTMLElement;
  };
}

function getWorkOptions(): CommonWorkOptions {
  return settingsMethods().getWorkOptions?.() ?? defaultWorkOptions;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toMode(value: unknown, fallback: StudyMode): StudyMode {
  return value === 'next' || value === 'job' || value === 'manually' ? value : fallback;
}

function buildStudyOptions(raw: Record<string, unknown>): StudyOptions {
  const automationFlags = resolveStudyAutomationFlags(raw);

  return {
    playbackRate: toNumber(raw.playbackRate, 1),
    volume: toNumber(raw.volume, 0),
    muteMedia: toBoolean(raw.muteMedia, true),
    videoQuizStrategy: raw.videoQuizStrategy === 'ignore' ? 'ignore' : 'random',
    mode: toMode(raw.mode, 'next'),
    restudy: toBoolean(raw.restudy, false),
    forceLearn: toBoolean(raw.forceLearn, false),
    backToFirstWhenFinish: toBoolean(raw.backToFirstWhenFinish, false),
    enableMedia: toBoolean(raw.enableMedia, true),
    enablePPT: toBoolean(raw.enablePPT, true),
    enableAnswer: automationFlags.enableAnswer,
    enableChapterTest: automationFlags.enableChapterTest,
    enableHyperlink: toBoolean(raw.enableHyperlink, true),
    notifyWhenHasFaceRecognition: toBoolean(raw.notifyWhenHasFaceRecognition, true),
    workOptions: getWorkOptions()
  };
}

async function runDirectReadPageTask(): Promise<void> {
  const timing = parseInt(new URL(location.href).searchParams.get('timing')?.toString() || '60');

  if (document.querySelector('#reader')) {
    await waitForElement('.readerPager', { timeout_seconds: 20, check_period_ms: 500 });
    const jumper = document.querySelector<HTMLSelectElement>('#pagejump');
    if (!jumper) {
      $console.warn('未找到阅读翻页控件，无法自动完成长时阅读任务。');
      return;
    }

    const stepSeconds = timing + 3;
    $message.info({
      content: `正在学习长时阅读任务，请稍等，不要切换..（预计${stepSeconds * 3}秒）`,
      duration: stepSeconds * 3000
    });

    await sleep(stepSeconds * 1000);
    jumper.value = '5';
    jumper.dispatchEvent(new Event('change'));
    $console.log('已跳转正文页');

    await sleep(stepSeconds * 1000);
    jumper.value = '7';
    jumper.dispatchEvent(new Event('change'));
    $console.log('已跳转封底页');

    await sleep(stepSeconds * 1000);
    const pager = Array.from(document.querySelectorAll<HTMLElement>('.readerPager')).find((el) => el.style.zIndex === '101');
    pager?.click();
    $console.log('阅读完成');
    return;
  }

  $console.log('正在完成书籍/PPT...');
  await sleep(5000);
  const readweb = (window as Record<string, any>).readweb;
  const epage = (window as Record<string, any>).epage;
  if (readweb?.goto && epage !== undefined) {
    readweb.goto(epage);
  }
}

function isAttachmentFinished(attachment: Attachment | undefined) {
  if (!attachment) return false;
  return attachment.job !== true || attachment.isPassed === true;
}

async function waitForAttachmentComplete(
  attachment: Attachment | undefined,
  timeoutMs = 30000,
  intervalMs = 1000
): Promise<boolean> {
  if (!attachment) {
    await sleep(3000);
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAttachmentFinished(attachment)) {
      return true;
    }
    await sleep(intervalMs);
  }
  return isAttachmentFinished(attachment);
}

async function waitForCurrentChapterFinished(timeoutMs = 15000, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (CXAnalyses.isCurrentChapterFinished()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return CXAnalyses.isCurrentChapterFinished();
}

export const CXProject = Project.create({
  name: '超星学习通',
  domains: [
    'chaoxing.com',
    'edu.cn',
    'org.cn',
    'xueyinonline.com',
    'hnsyu.net',
    'qutjxjy.cn',
    'ynny.cn',
    'hnvist.cn',
    'fjlecb.cn',
    'gdhkmooc.com',
    'cugbonline.cn',
    'zjelib.cn',
    'cqrspx.cn',
    'neauce.com',
    'zhihui-yun.com',
    'cqie.cn',
    'ccqmxx.com',
    'jxgmxy.com',
    'jnzyjsxy.cn',
    'sslibrary.com'
  ],
  scripts: {
    env: {
      name: '环境准备脚本',
      matches: [['所有页面', /.*/]],
      hideInPanel: true,
      onstart() {
        try {
          let current: Window = window;
          let tryCount = 10;
          while (current.parent !== undefined && tryCount > 0) {
            if (current.location.href.includes('/mycourse/studentstudy')) {
              topWindow = current;
              console.log('[chaoxing-plus] top change to ' + topWindow.location.href);
              break;
            }
            tryCount--;
            current = current.parent;
          }
        } catch (e) {
          console.warn('[chaoxing-plus] fail of find top');
          console.warn(e);
          topWindow = window.top ?? window;
        }
      }
    },
    guide: {
      name: '💡 使用提示',
      hideInPanel: true,
      matches: [
        ['首页', 'https://www.chaoxing.com'],
        ['旧版个人首页', 'chaoxing.com/space/index'],
        ['新版个人首页', 'chaoxing.com/base'],
        ['学习页面', 'chaoxing.com/mycourse'],
        ['新版学习页面', 'chaoxing.com/mooc2-ans/mycourse']
      ],
      namespace: 'cx.guide',
      configs: {
        notes: {
          defaultValue: '请手动进入视频、作业、考试页面，脚本会自动运行。'
        }
      },
      oncomplete() {
        if (location.href.includes('mycourse/studentstudy')) {
          $message.success('已进入学习页面，请等待自动运行...');
          return;
        }
        $message.info('请手动进入视频、作业、考试页面，脚本会自动运行。');
      }
    },
    study: {
      name: '🖥️ 课程学习',
      namespace: 'cx.new.study',
      hideInPanel: true,
      matches: [
        ['任务点页面', '/knowledge/cards'],
        ['阅读任务点', '/readsvr/book/mooc']
      ],
      configs: {
        notes: {
          defaultValue: [
            '任务点不是顺序执行，如果某一个任务没有动，请查看是否有其他任务正在学习。',
            '闯关模式请注意题库如果没完成，需要自己完成才能解锁章节。',
            '请勿凌晨刷课，部分学校课程可能会清空进度。',
            '⚠️目前超星倍速风控严重，如果高倍速完成后被清空还原，请调到1-2倍速学习！'
          ].join('\n')
        },
        playbackRate: {
          ...playbackRate,
          label: '视频倍速',
          options: playbackRate.options,
          defaultValue: playbackRate.defaultValue
        },
        volume: {
          ...volume,
          label: '视频音量',
          defaultValue: volume.defaultValue,
          attrs: { type: 'range', step: '0.05', min: '0', max: '1' }
        },
        muteMedia: {
          label: '视频静音',
          attrs: { type: 'checkbox', title: '开启后会将视频和音频静音播放。' },
          defaultValue: true
        },
        videoQuizStrategy: {
          label: '视频内题目',
          options: [
            ['random', '随机答题'],
            ['ignore', '忽略']
          ],
          defaultValue: 'random' as VideoQuizStrategy,
          attrs: {
            title: '视频播放过程中若弹出题目，可随机作答或直接忽略。'
          }
        },
        mode: {
          label: '跳转模式',
          options: [
            ['next', '完成后跳转下一节'],
            ['job', '完成后跳转未完成任务点'],
            ['manually', '完成后暂停，等待手动跳转']
          ],
          defaultValue: 'next' as StudyMode
        },
        restudy: {
          label: '复习模式',
          attrs: { title: '已经完成的视频继续学习，并从当前章节往下开始学习', type: 'checkbox' },
          defaultValue: false
        },
        forceLearn: {
          label: '强制学习',
          attrs: {
            title: '当遇到非任务点媒体时，开启后也会尝试学习。',
            type: 'checkbox'
          },
          defaultValue: false
        },
        backToFirstWhenFinish: {
          label: '完成全部后重新学习',
          attrs: {
            type: 'checkbox',
            title: '学习到最后一章后，自动返回第一章重新开始。'
          },
          defaultValue: false
        },
        enableMedia: {
          label: '视频/音频自动播放',
          attrs: { type: 'checkbox', title: '开启后自动播放视频和音频任务点。' },
          defaultValue: true
        },
        enablePPT: {
          label: 'PPT/书籍自动完成',
          attrs: { type: 'checkbox', title: '开启后自动完成 PPT、书籍、文档类任务。' },
          defaultValue: true
        },
        enableAnswer: {
          label: '自动答题',
          attrs: { type: 'checkbox', title: '关闭后将跳过章节测试自动答题，并忽略视频内题目的自动作答。' },
          defaultValue: true
        },
        enableChapterTest: {
          label: '章节测试自动答题',
          attrs: { type: 'checkbox', title: '开启后自动搜索并填写章节测试答案。' },
          defaultValue: true
        },
        enableHyperlink: {
          label: '链接任务自动完成',
          attrs: { type: 'checkbox', title: '开启后自动完成链接型任务点。' },
          defaultValue: true
        },
        notifyWhenHasFaceRecognition: {
          label: '出现人脸识别时提醒我',
          attrs: { type: 'checkbox' },
          defaultValue: true
        }
      },
      onrender() {
        const selectedRate = toNumber(this.cfg.playbackRate, 1);
        if (selectedRate > 2) {
          $console.warn('当前倍速大于 2 倍，超星可能出现进度清空或回退，请谨慎使用。');
        }
      },
      async onactive() {
        if (/\/readsvr\/book\/mooc/.test(location.href)) {
          await runDirectReadPageTask();
          return;
        }

        if (/\/knowledge\/cards/.test(location.href)) {
          const options = buildStudyOptions(this.cfg);
          await study(options);
        }
      }
    },
    work: {
      name: '✍️ 作业考试脚本',
      matches: [
        ['作业页面', '/mooc2/work/dowork'],
        ['考试整卷预览页面', '/mooc2/exam/preview']
      ],
      namespace: 'cx.new.work',
      hideInPanel: true,
      configs: {
        notes: {
          defaultValue: '已接入作业/考试答题主链路。'
        }
      },
      oncomplete() {
        const isExam = /\/exam\/preview/.test(location.href);
        commonWork(
          this,
          {
            workerProvider: (opts) => workOrExam(isExam ? 'exam' : 'work', { ...opts, preview_mode: true }),
            enable_control_panel: true
          },
          getWorkOptions()
        );
      }
    },
    autoRead: {
      name: '🖥️ 自动阅读',
      matches: [
        ['阅读页面', '/ztnodedetailcontroller/visitnodedetail'],
        ['课程目录', /chaoxing.com\/course\/\d+\.html/],
        ['课程目录', /chaoxing.com\/mooc-ans\/course\/\d+\.html/],
        ['积分课阅读课程目录', '/mooc-ans/zt/portal']
      ],
      namespace: 'cx.new.auto-read',
      configs: {
        notes: {
          defaultValue: '自动阅读链路将在后续任务中迁入。'
        }
      }
    },
    pageRedirect: {
      name: '章节页面自动切换脚本',
      matches: [['课程任务页面', 'pageHeader=0']],
      hideInPanel: true,
      async oncomplete() {
        if (topWindow === window) {
          const a = document.querySelector<HTMLElement>('a[title="章节"]');
          if (a) {
            await sleep(1000);
            a.click();
            $message.info('已经为您自动切换到章节列表页面，手动进入任意章节即可开始自动学习！');
          }
        }
      }
    },
    versionRedirect: {
      name: '版本切换脚本',
      matches: [
        ['', 'mooc2=0'],
        ['', 'mycourse/studentcourse'],
        ['', 'work/getAllWork'],
        ['', 'work/doHomeWorkNew'],
        ['', 'exam/test\\?'],
        ['', 'mooc-ans/mycourse/studentstudy']
      ],
      hideInPanel: true,
      async oncomplete() {
        if (topWindow === window) {
          $message.warn('当前页面像是旧版超星页面，即将尝试自动切换到新版。');
          await sleep(2000);
          await waitForFaceRecognition();

          const experience = document.querySelector('.experience') as HTMLElement | null;
          if (experience) {
            experience.click();
          } else {
            const newUrl = new URL(window.location.href);
            if (window.location.href.includes('mooc-ans/mycourse/studentstudy')) {
              newUrl.pathname = '/mycourse/studentstudy';
            }
            const params = newUrl.searchParams;
            let changed = false;
            if (params.get('mooc2') !== '1') {
              params.set('mooc2', '1');
              changed = true;
            }
            if (params.get('newMooc') !== 'true') {
              params.set('newMooc', 'true');
              changed = true;
            }
            if (changed) {
              window.location.replace(newUrl.toString());
            }
          }
        }
      }
    },
    examRedirect: {
      name: '考试整卷预览脚本',
      matches: [
        ['新版考试页面', 'exam-ans/exam/test/reVersionTestStartNew'],
        ['新版考试页面2', 'mooc-ans/exam/test/reVersionTestStartNew']
      ],
      hideInPanel: true,
      oncomplete() {
        const unsafeDocument = ($gm.unsafeWindow as Window & { document?: Document }).document;
        if (unsafeDocument?.querySelector('.mark_info')?.textContent?.includes('不允许整卷预览')) {
          $message.warn('当前考试禁止整卷预览，将按逐题模式运行。');
          const workOptions = getWorkOptions();
          commonWork(
            CXProject.scripts.work,
            {
              start_delay_seconds: workOptions.period,
              enable_control_panel: true,
              workerProvider: (opts) => workOrExam('exam', { ...opts, preview_mode: false, thread: 1 })
            },
            workOptions
          );
          return;
        }
        $message.info('即将跳转到整卷预览页面进行考试。');
        setTimeout(() => {
          const preview = ($gm.unsafeWindow as Record<string, any>).topreview;
          if (typeof preview === 'function') {
            preview();
          }
        }, 3000);
      }
    },
    rateHack: {
      name: '屏蔽倍速限制',
      hideInPanel: true,
      matches: [['', '/ananas/modules/video/']],
      onstart() {
        rateHack();
      }
    },
    copyHack: {
      name: '屏蔽复制粘贴限制',
      hideInPanel: true,
      matches: [['所有页面', /.*/]],
      oncomplete() {
        enableCopy([document, document.body]);
        const interval = window.setInterval(() => {
          enableCopy(Array.from(document.querySelectorAll<HTMLElement>('textarea,input,[contenteditable="true"]')));
        }, 1000);
        window.setTimeout(() => {
          window.clearInterval(interval);
        }, 15000);
      }
    },
    studyDispatcher: {
      name: '课程学习调度器',
      matches: [['课程学习页面', '/mycourse/studentstudy']],
      namespace: 'cx.new.study-dispatcher',
      hideInPanel: true,
      async oncomplete() {
        const restudy = toBoolean(this.cfg.restudy, false);
        renderMethods().pin?.(CXProject.scripts.study);

        let chapters = await CXAnalyses.waitForChapterInfos();

        if (!restudy) {
          const url = new URL(window.location.href);
          if (url.searchParams.get('mooc2') === null) {
            url.searchParams.set('mooc2', '1');
            window.location.replace(url.toString());
            return;
          }

          chapters = chapters.filter((chapter) => chapter.unFinishCount !== 0);

          if (chapters.length === 0) {
            $message.warn('页面任务点数量为空! 请刷新重试!');
          } else {
            const courseId = url.searchParams.get('courseId');
            const classId = url.searchParams.get('clazzid');
            setTimeout(() => {
              const activeId = `cur${chapters[0].chapterId}`;
              if (courseId && classId && chapters[0].chapterId && topWindow.document.querySelector(`.posCatalog_active[id="${activeId}"]`) === null) {
                const getTeacherAjax = (topWindow as Record<string, any>).getTeacherAjax;
                if (typeof getTeacherAjax === 'function') {
                  getTeacherAjax(courseId, classId, chapters[0].chapterId);
                  setTimeout(() => {
                    CXAnalyses.scrollToActiveChapter();
                  }, 1000);
                }
              }
            }, 1000);
          }
        } else {
          setTimeout(() => {
            CXAnalyses.scrollToActiveChapter();
          }, 1000);
        }
      }
    },
    cxSecretFontRecognize: {
      name: '繁体字识别',
      hideInPanel: true,
      matches: [
        ['题目页面', 'work/doHomeWorkNew'],
        ['考试整卷预览', '/mooc2/exam/preview'],
        ['作业', '/mooc2/work/dowork']
      ],
      async oncomplete() {
        await mappingRecognize(document);
      }
    },
    jfkGuide: {
      name: '💡 积分课使用提示',
      matches: [['积分课页面', '/plaza']],
      namespace: 'cx.jfk.guide',
      configs: {
        notes: {
          defaultValue: '积分课请进入课程后开启复习模式，并谨慎使用自动跳转。'
        }
      },
      oncomplete() {
        $message.info('积分课页面已匹配，可继续手动进入具体课程。');
      }
    }
  }
});

const chapterCounter = new Map<string, number>();

export const CXAnalyses = {
  isInSpecialMode() {
    return Array.from(topWindow.document.querySelectorAll('.catalog_points_sa,.catalog_points_er') || []).length !== 0;
  },
  async isStuckInBreakingMode() {
    if (this.isInSpecialMode()) {
      const chapter = topWindow.document.querySelector<HTMLElement>('.posCatalog_active');
      if (chapter) {
        const id = chapter.getAttribute('id');
        if (id) {
          const count = (chapterCounter.get(id) ?? 0) + 1;
          chapterCounter.set(id, count >= 3 ? 1 : count);
          return count >= 3;
        }
      }
    }
    return false;
  },
  isInFinalTab() {
    const tabs = Array.from<HTMLElement>(topWindow.document.querySelectorAll('.prev_ul li') || []);
    if (tabs.length === 0) {
      return true;
    }
    return tabs[tabs.length - 1].classList.contains('active');
  },
  isInFinalChapter() {
    return Array.from(topWindow.document.querySelectorAll('.posCatalog_select') || [])
      .pop()
      ?.classList.contains('posCatalog_active');
  },
  isFinishedAllChapters() {
    return this.getChapterInfos().every((chapter) => chapter.unFinishCount === 0);
  },
  getChapterInfos() {
    return Array.from(topWindow.document.querySelectorAll('[onclick^="getTeacherAjax"]') || []).map((el) => ({
      element: el as HTMLElement,
      chapterId: el.getAttribute('onclick')?.match(/\('(.*)','(.*)','(.*)'\)/)?.[3],
      unFinishCount: parseInt((el.parentElement?.querySelector('.jobUnfinishCount') as HTMLInputElement | null)?.value || '0')
    }));
  },
  scrollToActiveChapter() {
    const activeChapter = topWindow.document.querySelector<HTMLElement>('.posCatalog_active');
    if (activeChapter) {
      activeChapter.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
  waitForChapterInfos(timeout = 10) {
    return new Promise<Array<{ element: HTMLElement; chapterId?: string; unFinishCount: number }>>((resolve) => {
      const interval = setInterval(() => {
        const res = this.getChapterInfos();
        if (res.length > 0) {
          clearInterval(interval);
          clearTimeout(to);
          resolve(res);
        }
      }, 1000);

      const to = setTimeout(() => {
        clearInterval(interval);
        resolve([]);
      }, timeout * 1000);
    });
  },
  getSecretFont(doc: Document = document) {
    return Array.from(doc.querySelectorAll('.font-cxsecret')).map((font) => {
      const after = font.querySelector('.after');
      return after === null ? (font as HTMLElement) : (after as HTMLElement);
    }) as HTMLElement[];
  },
  isCurrentChapterFinished() {
    const job = topWindow.document.querySelector('.posCatalog_active');
    return Boolean(job && job.querySelector('.icon_Completed') !== null);
  }
};

function rateHack() {
  state.study.hacked = false;
  let dragCount = 0;

  const hack = () => {
    const unsafeWindow = $gm.unsafeWindow as Record<string, any>;
    const videojs = unsafeWindow.videojs;
    const Ext = unsafeWindow.Ext;

    if (typeof videojs === 'undefined' || typeof Ext === 'undefined' || state.study.hacked) {
      return;
    }

    state.study.hacked = true;

    try {
      const origin = videojs.getPlugin?.('seekBarControl');
      if (origin && videojs.extend && videojs.registerPlugin) {
        const plugin = videojs.extend(videojs.getPlugin('plugin'), {
          constructor: function (videoExt: any, data: any) {
            const sendLog = data.sendLog;
            data.sendLog = (...args: any[]) => {
              if (args[1] === 'drag') {
                dragCount++;
                if (dragCount > 100) {
                  dragCount = 0;
                  document.querySelector<HTMLVideoElement>('video')?.pause();
                }
              } else {
                sendLog?.apply(data, args);
              }
            };

            origin.apply(origin.prototype, [videoExt, data]);
          }
        });

        videojs.registerPlugin('seekBarControl', plugin);
      }

      if (typeof Ext.define === 'function') {
        Ext.define('ans.VideoJs', {
          override: 'ans.VideoJs',
          constructor: function (data: any) {
            this.addEvents?.(['seekstart']);
            this.mixins?.observable?.constructor?.call(this, data);
            const vjs = videojs(data.videojs, this.params2VideoOpt(data.params), function () {});
            Ext.fly(data.videojs).on('contextmenu', function (f: any) {
              f.preventDefault();
            });
            Ext.fly(data.videojs).on('keydown', function (f: any) {
              if (f.keyCode === 32 || f.keyCode === 37 || f.keyCode === 39 || f.keyCode === 107) {
                f.preventDefault();
              }
            });

            if (vjs.videoJsResolutionSwitcher) {
              vjs.on('resolutionchange', function () {
                const cr = vjs.currentResolution();
                const re = cr.sources ? cr.sources[0].res : false;
                Ext.setCookie('resolution', re);
              });
            }

            if (vjs.videoJsPlayLine) {
              vjs.on('playlinechange', function () {
                const cp = vjs.currentPlayline();
                Ext.setCookie('net', cp.net);
              });
            }
          }
        });
      }
    } catch (error) {
      console.error('[chaoxing-plus] rateHack failed', error);
    }
  };

  try {
    hack();
    window.document.addEventListener('readystatechange', hack);
    window.addEventListener('load', hack);
  } catch (error) {
    console.error(error);
  }
}

export async function study(opts: StudyOptions) {
  await sleep(3000);

  const searchedJobs: Job[] = [];
  let searching = true;
  let attachmentCount: number = (($gm.unsafeWindow as any).attachments?.length as number) || 0;
  const waitTimeout = 3 + attachmentCount * 2;

  setTimeout(() => {
    searching = false;
  }, Math.min(waitTimeout, 10) * 1000);

  const runJobs = async (): Promise<void> => {
    const job = searchJob(opts, searchedJobs);
    if (job && job.func) {
      try {
        await job.func();
      } catch (e) {
        $console.error('未知错误', e);
      }

      await sleep(1000);
      await runJobs();
    } else if (attachmentCount > 0) {
      attachmentCount--;
      await sleep(1000);
      await runJobs();
    } else if (searching) {
      await sleep(1000);
      await runJobs();
    }
  };

  await runJobs();
  (topWindow as Record<string, any>)._preChapterId = '';

  const next = async () => {
    if (CXAnalyses.isInFinalTab() && (await CXAnalyses.isStuckInBreakingMode())) {
      $message.warn('检测到当前课程可能处于闯关模式且重复进入多次，请先手动完成未完成的章节测试。');
      return;
    }

    if (CXAnalyses.isInFinalChapter()) {
      let content = '';

      if (opts.backToFirstWhenFinish) {
        content = '已经抵达最后一个章节，10秒后返回第一个章节重新开始。';
        showTopCenterNotice(content, { duration: 10000, tone: 'info' });
        setTimeout(() => {
          topWindow.document.querySelector<HTMLElement>('.posCatalog_name')?.click();
        }, 10 * 1000);
        $message.info({ content, duration: 30000 });
      } else {
        content = CXAnalyses.isFinishedAllChapters()
          ? '全部任务点已完成！'
          : '已经抵达最后一个章节！但仍然有任务点未完成，请手动切换至未完成的章节。';
        if (CXAnalyses.isFinishedAllChapters()) {
          showTopCenterNotice(content, { duration: 5000, tone: 'success' });
        } else {
          showTopCenterNotice(content, { duration: 0, tone: 'warning' });
        }
        $message.warn(content);
      }

      settingsMethods().notificationBySetting?.(content);
      return;
    }

    if (opts.mode === 'job') {
      if (CXAnalyses.isInFinalTab()) {
        const elements = CXAnalyses.getChapterInfos()
          .filter((el) => el.unFinishCount > 0 || el.element.parentElement?.classList.contains('posCatalog_active'))
          .map((el) => el.element.parentElement as HTMLElement);

        if (elements.length === 0) {
          const content = '全部任务点已完成！';
          showTopCenterNotice(content, { duration: 5000, tone: 'success' });
          $message.info(content);
          settingsMethods().notificationBySetting?.(content);
          return;
        }

        let nextChapter = elements[0];
        const currentIndex = elements.findIndex((el) => el.classList.contains('posCatalog_active'));
        if (currentIndex !== -1 && currentIndex + 1 < elements.length) {
          nextChapter = elements[currentIndex + 1];
          CXAnalyses.scrollToActiveChapter();
          setTimeout(() => {
            nextChapter.querySelector<HTMLElement>('.posCatalog_name')?.click();
          }, 1000);
        }
      }
    } else if (opts.mode === 'next') {
      const curCourseId = topWindow.document.querySelector<HTMLInputElement>('#curCourseId');
      const curChapterId = topWindow.document.querySelector<HTMLInputElement>('#curChapterId');
      const curClazzId = topWindow.document.querySelector<HTMLInputElement>('#curClazzId');
      const count = Array.from(topWindow.document.querySelectorAll('#prev_tab .prev_ul li'));

      if (curChapterId && curCourseId && curClazzId) {
        (topWindow as Record<string, any>)._preChapterId = curChapterId.value;
        CXAnalyses.scrollToActiveChapter();
        await sleep(200);
        const nextFn = (topWindow as Record<string, any>).PCount?.next;
        if (typeof nextFn === 'function') {
          nextFn(count.length.toString(), curChapterId.value, curCourseId.value, curClazzId.value, '');
        } else {
          $console.warn('参数错误，无法跳转下一章，请尝试手动切换。');
        }
      } else {
        $console.warn('参数错误，无法跳转下一章，请尝试手动切换。');
      }
    } else {
      $console.warn('未知的跳转模式，请联系作者反馈');
    }
  };

  if (opts.mode !== 'manually') {
    const msg = '页面任务点已完成，即将跳转。';
    showTopCenterNotice(msg, { duration: 5000, tone: 'success' });
    $message.success(msg);
    $console.info(msg);
    await sleep(5000);
    await next();
  } else {
    const msg = '页面任务点已完成，自动跳转已关闭，请手动跳转。';
    showTopCenterNotice(msg, { duration: 0, tone: 'warning' });
    $message.warn({ content: msg, duration: 0 });
    $console.warn(msg);
  }
}

function searchIFrame(root: Document) {
  let list = Array.from(root.querySelectorAll('iframe'));
  const result: HTMLIFrameElement[] = [];
  while (list.length) {
    const frame = list.shift();

    try {
      if (frame?.contentWindow?.document) {
        result.push(frame);
        const frames = frame.contentWindow.document.querySelectorAll('iframe');
        list = list.concat(Array.from(frames || []));
      }
    } catch (e) {
      console.log((e as Error).message);
    }
  }
  return result;
}

function searchJob(opts: StudyOptions, searchedJobs: Job[]): Job | undefined {
  const knowCardWin = $gm.unsafeWindow as Window & Record<string, any>;

  const searchJobElement = (root: HTMLIFrameElement) => {
    return domSearch(
      {
        videojs: '#video,#audio',
        chapterTest: '.TiMu',
        read: '#img.imglook',
        pptWithAudio: '.swiper-container',
        hyperlink: '#hyperlink',
        timereader: 'iframe[name="bookifame"][src*="timing"]'
      },
      root.contentWindow!.document
    );
  };

  const search = (root: HTMLIFrameElement): Job | undefined => {
    const win = root.contentWindow;
    const { videojs, read, chapterTest, hyperlink, pptWithAudio, timereader } = searchJobElement(root);

    if (win && (videojs || read || chapterTest || hyperlink || pptWithAudio || timereader)) {
      const frameDataStr =
        win.frameElement?.getAttribute('data') ||
        ((win.frameElement as HTMLIFrameElement | null)?.contentWindow?.parent.frameElement?.getAttribute('data') ?? '{}');
      const frameData = JSON.parse(frameDataStr);
      const targetJobId = frameData.jobid || frameData._jobid;
      if (!targetJobId) {
        return undefined;
      }

      const attachment: Attachment | undefined = (knowCardWin.attachments as Attachment[] | undefined)?.find((item) => {
        const attachmentJobId = item.jobid || item.property._jobid;
        if (!attachmentJobId) {
          return false;
        }
        return String(attachmentJobId) === String(targetJobId);
      });

      if (attachment && searchedJobs.find((job) => job.mid === attachment.property.mid) === undefined) {
        const { name, title, bookname, author } = attachment.property;
        const jobName = name || title || (bookname ? `${bookname}${author ?? ''}` : undefined) || '未知任务';
        const workType = attachment.job ? 'job' : attachment.isPassed ? 'finished' : 'not-job';

        let func: (() => Promise<void>) | undefined;

        if (videojs) {
          if (!opts.enableMedia) {
            const msg = `音视频自动学习功能已被关闭。${jobName} 即将跳过`;
            $message.warn({ content: msg, duration: 10000 });
            $console.warn(msg);
          } else if (workType === 'job' || (workType === 'finished' && opts.restudy) || (workType === 'not-job' && opts.forceLearn)) {
            func = async () => {
              const msg = `即将${workType === 'finished' && opts.restudy ? '重新' : workType === 'not-job' && opts.forceLearn ? '强制' : ''}播放 : ${jobName}`;
              $message.info(msg);
              $console.log(msg);
              await JobRunner.media(opts, win.document);
            };
          }
        } else if (chapterTest) {
          if (!opts.enableAnswer) {
            const msg = `自动答题总开关已关闭。${jobName} 即将跳过`;
            $message.warn({ content: msg, duration: 10000 });
            $console.warn(msg);
          } else if (!opts.enableChapterTest) {
            const msg = `章节测试自动答题功能已被关闭。${jobName} 即将跳过`;
            $message.warn({ content: msg, duration: 10000 });
            $console.warn(msg);
          } else {
            const status = win.document.querySelector<HTMLElement>('.testTit_status');
            if (status?.classList.contains('testTit_status_complete')) {
              const msg = `章节测试已完成 : ${jobName}`;
              $message.success(msg);
              $console.log(msg);
            } else if (workType === 'job') {
              func = async () => {
                const msg = `正在处理章节测试 : ${jobName}`;
                $message.info(msg);
                $console.log(msg);
                await JobRunner.chapter(root, opts.workOptions);
              };
            }
          }
        } else if (read || pptWithAudio || timereader) {
          if (!opts.enablePPT) {
            const msg = `PPT/书籍阅读功能已被关闭。${jobName} 即将跳过`;
            $message.warn({ content: msg, duration: 10000 });
            $console.warn(msg);
          } else if (attachment.job) {
            func = async () => {
              const msg = `正在学习 : ${jobName}`;
              $message.info(msg);
              $console.log(msg);
              if (read) {
                await JobRunner.read(win as Window & { finishJob?: () => void }, attachment);
              } else if (timereader) {
                await JobRunner.timereader(timereader as HTMLIFrameElement, attachment);
              } else {
                await JobRunner.readPPTWithAudio(win as Window & { swiperNext?: () => void }, attachment);
              }
            };
          }
        } else if (hyperlink) {
          if (!opts.enableHyperlink) {
            const msg = `链接任务点已被关闭。${jobName} 即将跳过`;
            $message.warn({ content: msg, duration: 10000 });
            $console.warn(msg);
          } else if (attachment.job) {
            func = async () => {
              const msg = `正在完成链接阅读任务 : ${jobName}`;
              $message.info(msg);
              $console.log(msg);
              await JobRunner.hyperlink(hyperlink as HTMLElement);
            };
          }
        }

        const job = {
          mid: attachment.property.mid,
          attachment,
          func
        };

        searchedJobs.push(job);
        return job;
      }
    }

    return undefined;
  };

  for (const iframe of searchIFrame(knowCardWin.document)) {
    const job = search(iframe);
    if (job) {
      return job;
    }
  }

  return undefined;
}

export function fixedVideoProgress() {
  const bar = state.study.videojs?.querySelector<HTMLElement>('.vjs-control-bar');
  if (bar) {
    bar.style.opacity = '1';
  }
}

const JobRunner = {
  async media(setting: Pick<StudyOptions, 'playbackRate' | 'volume' | 'muteMedia' | 'videoQuizStrategy' | 'enableAnswer'>, doc: Document) {
    const { playbackRate = 1, volume = 0, muteMedia = true } = setting;
    const media = await waitForMedia({ root: doc });
    const { videojs } = domSearch({ videojs: '#video,#audio' }, doc);

    if (!videojs || !media) {
      $console.error('视频检测不到，请尝试刷新或者手动切换下一章。');
      return;
    }

    state.study.videojs = videojs as HTMLElement;
    (topWindow as Record<string, any>).currentMedia = media;
    fixedVideoProgress();

    if (setting.enableAnswer && setting.videoQuizStrategy === 'random') {
      const loop = async (): Promise<void> => {
        const submitBtn = () => doc.querySelector<HTMLElement>('#videoquiz-submit');
        if (submitBtn()) {
          const list = Array.from(doc.querySelectorAll<HTMLElement>('.ans-videoquiz-opt label'));
          const answer = list[Math.floor(Math.random() * list.length)];
          answer?.click();
          submitBtn()?.click();
          await sleep(3000);
          doc.querySelector<HTMLElement>('#video .ans-videoquiz')?.remove();
          Array.from(doc.querySelectorAll<HTMLElement>('.x-component-default')).forEach((com) => {
            com.style.display = 'none';
          });
        }
        await sleep(3000);
        await loop();
      };
      void loop();
    }

    return new Promise<void>((resolve) => {
      const reloadInterval = setInterval(() => {
        const errorDiv = doc.querySelector<HTMLElement>('.vjs-modal-dialog-content');
        if (
          ['视频文件损坏', '网络错误导致视频下载中途失败', '视频因格式不支持', '网络的问题无法加载'].some((s) =>
            errorDiv?.innerText.includes(s)
          )
        ) {
          $console.error('检测到视频加载失败，即将跳过视频。');
          $message.error('检测到视频加载失败，即将跳过视频。');
          clearInterval(reloadInterval);
          setTimeout(resolve, 3000);
        }
      }, 3000);

      const playFunction = async () => {
        if (hasFaceRecognition()) await waitForFaceRecognition();
        if (hasNewFaceRecognition()) await waitForNewFaceRecognition();
        if (media.ended === false) {
          await sleep(1000);
          void media.play();
          media.playbackRate = playbackRate;
        }
      };

      const onPause = () => {
        void playFunction();
      };

      media.addEventListener('pause', onPause);
      media.addEventListener('ended', () => {
        media.removeEventListener('pause', onPause);
        $console.log('视频播放完毕');
        clearInterval(reloadInterval);
        resolve();
      });

      $console.log('视频开始播放');
      media.muted = muteMedia;
      media.volume = volume;
      media.currentTime = 0;

      setTimeout(() => {
        void playMedia(() => media.play()).then((played) => {
          if (played) {
            media.playbackRate = playbackRate;
          }
        });
      }, 200);
    });
  },
  async read(win: Window & { finishJob?: () => void }, attachment?: Attachment) {
    await waitForElement(() => (win.document.readyState === 'complete' ? win.document.body ?? undefined : undefined), {
      timeout_seconds: 10,
      check_period_ms: 500
    });

    win.finishJob?.();
    await sleep(3000);

    const finished = await waitForAttachmentComplete(attachment, 15000);
    if (!finished) {
      await waitForCurrentChapterFinished(10000);
    }
  },
  async timereader(iframe: HTMLIFrameElement, attachment?: Attachment) {
    const src = iframe.getAttribute('src')?.toString() || '';
    const timing = src ? parseInt(new URL(src).searchParams.get('timing')?.toString() || '60') : 60;
    $message.info({
      content: `正在学习长时阅读任务，请稍等，不要切换..（预计${(timing + 3) * 3}秒）`,
      duration: (timing + 3) * 3000
    });
    await sleep((timing + 3) * 3 * 1000);
    const finished = await waitForAttachmentComplete(attachment, 15000);
    if (!finished) {
      await waitForCurrentChapterFinished(10000);
    }
    $message.success('长时阅读任务完成！');
    await sleep(5000);
  },
  async chapter(frame: HTMLIFrameElement, options: CommonWorkOptions) {
    const {
      answererWrappers,
      period,
      upload,
      thread,
      stopSecondWhenFinish,
      redundanceWordsText,
      answerSeparators,
      answerMatchMode
    } = options;

    if (answererWrappers === undefined || answererWrappers.length === 0) {
      return answerWrapperEmptyWarning(0);
    }

    $console.info('开始章节测试');
    const frameWindow = frame.contentWindow;
    const frameDocument = frameWindow?.document;
    if (!frameWindow || !frameDocument) {
      $console.warn('章节测试窗口不可访问，已跳过。');
      return;
    }

    const { TiMu } = domSearch({ TiMu: '.TiMu' }, frameDocument);
    const roots = Array.isArray(TiMu) ? (TiMu as HTMLElement[]) : [];
    if (roots.length === 0) {
      $console.warn('未找到章节测试题目，已跳过。');
      return;
    }

    renderMethods().normal?.();
    workResultsMethods().init?.({ questionPositionSyncHandlerType: 'cx' });
    renderMethods().pin?.(CommonProject.scripts.workResults);

    const chapterTestTaskQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) => {
      const removed = removeRedundantWords(
        titles.map((t) => (t ? optimizationElementWithImage(t, true).innerText : '')).join(','),
        redundanceWordsText.split('\n')
      );

      return removed
        .trim()
        .replace(/^\d+[。、.]/, '')
        .replace(/（\d+\.\d+分）/, '')
        .replace(/\(..题, \d+?分\)/, '')
        .replace(/\(..题, \d+\.\d+分\)/, '')
        .replace(/[[(【（](..题|名词解释|完形填空|阅读理解)[\])】）]/, '')
        .trim();
    };

    const createChapterWorker = (questionRoots: HTMLElement[]) =>
      new OCSWorker({
        root: questionRoots,
        elements: {
          title: '.Zy_TItle .clearfix',
          options: 'ul li .after,ul li textarea,ul textarea,ul li label:not(.before)',
          type: 'input[id^="answertype"]',
          lineAnswerInput: '.line_answer input[name^=answer]',
          lineSelectBox: '.line_answer_ct .selectBox '
        },
        thread: thread ?? 1,
        answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
        answerMatchMode: answerMatchMode === 'includes' ? 'similar' : answerMatchMode,
        answerer: (elements, ctx) => {
          const title = chapterTestTaskQuestionTitleTransform(elements.title);
          if (!title) {
            throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
          }

          const typeInput = elements.type[0] as HTMLInputElement | undefined;
          const provider = async () => {
            await sleep((period ?? 3) * 1000);
            return defaultAnswerWrapperHandler(answererWrappers, {
              type: (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown',
              title,
              options:
                ctx.type === 'completion'
                  ? ''
                  : ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText).join('\n')
            });
          };

          const searchInCaches = appsMethods().searchAnswerInCaches;
          return searchInCaches ? searchInCaches(title, provider) : provider();
        },
        work: async (ctx) => {
          const { elements, searchInfos } = ctx;
          const typeInput = elements.type[0] as HTMLInputElement | undefined;
          const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

          if (type && (type === 'completion' || type === 'multiple' || type === 'judgement' || type === 'single')) {
            const resolver = createDefaultQuestionResolver(ctx)[type];

            const handler = async (questionType: typeof type, answer: string, option: HTMLElement | undefined) => {
              if ((questionType === 'judgement' || questionType === 'single' || questionType === 'multiple') && option) {
                const checked =
                  option.parentElement?.querySelector('label input')?.getAttribute('checked') === 'checked' ||
                  option.parentElement?.getAttribute('aria-checked') === 'true';
                if (!checked) {
                  option.click();
                }
              } else if (questionType === 'completion' && option && answer.trim()) {
                const text = option.parentElement?.querySelector('textarea');
                const textareaFrame = option.parentElement?.querySelector('iframe');
                if (text) {
                  text.value = answer;
                }
                if (textareaFrame?.contentDocument) {
                  textareaFrame.contentDocument.body.innerHTML = answer;
                }
                option.parentElement?.parentElement?.querySelector<HTMLElement>('[onclick*=saveQuestion]')?.click();
              }
            };

            return resolver(searchInfos, elements.options.map((option) => optimizationElementWithImage(option)), handler as any);
          } else if (type === 'line') {
            for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
              let ans = answers;
              if (ans.length === 1) {
                ans = splitAnswer(ans[0]);
              }
              if (ans.filter(Boolean).length !== 0 && elements.lineAnswerInput) {
                for (let index = 0; index < elements.lineSelectBox.length; index++) {
                  const box = elements.lineSelectBox[index];
                  if (ans[index]) {
                    box.querySelector<HTMLElement>(`li[data="${ans[index]}"] a`)?.click();
                    await sleep(200);
                  }
                }
                return { finish: true };
              }
            }

            return { finish: false };
          }

          return { finish: false };
        },
        async onResultsUpdate(curr, currentIndex, res) {
          const simplified = simplifyWorkResult(res, chapterTestTaskQuestionTitleTransform);
          workResultsMethods().setResults?.(simplified);
          workResultsMethods().updateWorkStateByResults?.(res);

          const currentRoot = questionRoots[currentIndex];
          const typeInput = currentRoot?.querySelector<HTMLInputElement>('input[id^="answertype"]');
          const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;
          if (currentRoot) {
            const previousManual = workResultsMethods().getResults?.()[currentIndex]?.manual ?? false;
            workResultsMethods().patchResult?.(currentIndex, {
              manual: detectManualAnswer(currentRoot, type, {
                previousManual,
                result: curr
              })
            });
          }

          if (curr.result?.finish) {
            appsMethods().addQuestionCacheFromWorkResult?.(simplified.filter((_, index) => index === res.indexOf(curr)));
          }
        },
        async onElementSearched(elements) {
          const typeInput = elements.type[0] as HTMLInputElement | undefined;
          const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;
          if (type === 'judgement') {
            elements.options.forEach((option) => {
              const opt = option?.textContent?.trim() || '';
              if (opt.includes('对') || opt.includes('错')) {
                return;
              }
              if (opt === 'True' || opt === '對') {
                option.textContent = '√';
              } else if (opt === 'False' || opt === '錯') {
                option.textContent = 'x';
              } else {
                const ri = option.querySelector('.ri');
                const span = document.createElement('span');
                span.innerText = ri ? '√' : '×';
                option.appendChild(span);
              }
            });
          }
        }
      });

    const worker = createChapterWorker(roots);
    const clearRuntimeControls = () => workResultsMethods().clearRuntimeControls?.();

    workResultsMethods().setRuntimeControls?.({
      isRunning: () => worker.isRunning,
      isStopped: () => worker.isStop,
      stop: () => worker.emit('stop'),
      continuate: () => worker.emit('continuate'),
      canRetryQuestion: (index) => Boolean(roots[index]),
      retryQuestion: async (index) => {
        const root = roots[index];
        if (!root) {
          return undefined;
        }

        const retryWorker = createChapterWorker([root]);
        const retriedResults = await retryWorker.doWork();
        return {
          ...simplifyWorkResult(retriedResults, chapterTestTaskQuestionTitleTransform)[0],
          manual: false,
          retrying: false
        };
      }
    });

    worker.on('done', clearRuntimeControls);
    worker.on('close', clearRuntimeControls);

    const results = await worker.doWork();
    const msg = `答题完成，将等待 ${stopSecondWhenFinish} 秒后进行保存或提交。`;
    $console.info(msg);
    $message.info({ content: msg, duration: stopSecondWhenFinish * 1000 });
    await sleep(stopSecondWhenFinish * 1000);

    await worker.uploadHandler({
      type: upload === 'submit' ? 100 : upload,
      results,
      async callback(finishedRate, uploadable) {
        const uploadMsg = `完成率 ${finishedRate.toFixed(2)}% : ${uploadable ? '3秒后将自动提交' : '3秒后将自动保存'}`;
        $console.info(uploadMsg);
        $message.success({ content: uploadMsg, duration: 3000 });
        await sleep(3000);

        if (uploadable) {
          (frameWindow as Record<string, any>).btnBlueSubmit?.();
          await sleep(3000);
          (frameWindow as Record<string, any>).submitCheckTimes?.();
          (topWindow as Record<string, any>).$?.('#workpop')?.hide?.();
        } else {
          (frameWindow as Record<string, any>).alert = () => {};
          (frameWindow as Record<string, any>).noSubmit?.();
        }
      }
    });

    worker.emit('done');
  },
  async readPPTWithAudio(win: Window & { swiperNext?: () => void }, attachment?: Attachment) {
    win.document.querySelectorAll('audio').forEach((audio) => {
      audio.addEventListener('play', () => {
        audio.muted = true;
      });
    });

    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.swiper-container .swiper-slide'));
    const len = slides.length;
    for (let index = 0; index < len; index++) {
      win.swiperNext?.();
      await sleep(1000);
    }

    await sleep(3000);
    const finished = await waitForAttachmentComplete(attachment, 15000);
    if (!finished) {
      await waitForCurrentChapterFinished(10000);
    }
  },
  async hyperlink(a: HTMLElement) {
    const originalClick = a.onclick;
    a.onclick = () => false;
    a.click();
    a.onclick = originalClick;
    await sleep(3000);
  }
};

function workOrExam(
  type: 'work' | 'exam' = 'work',
  {
    answererWrappers,
    period,
    thread,
    redundanceWordsText,
    answerSeparators,
    answerMatchMode,
    preview_mode
  }: CommonWorkOptions & {
    preview_mode: boolean;
  }
) {
  $message.info(`开始${type === 'work' ? '作业' : '考试'}`);

  if (preview_mode) {
    workResultsMethods().init?.();
  }

  const workOrExamQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) => {
    const optimizationTitle = titles
      .map((titleElement) => {
        if (titleElement) {
          const titleCloneEl = titleElement.cloneNode(true) as HTMLElement;
          while (titleCloneEl.childNodes.length > 0 && titleCloneEl.childNodes[0]) {
            titleCloneEl.childNodes[0].remove();
            break;
          }
          while (titleCloneEl.childNodes.length > 0 && titleCloneEl.childNodes[0]) {
            titleCloneEl.childNodes[0].remove();
            break;
          }
          return optimizationElementWithImage(titleCloneEl, true).innerText;
        }
        return '';
      })
      .join(',');

    return removeRedundantWords(
      optimizationTitle.replace(/\s+/g, ' ').replace(/\s+/g, '').trim(),
      redundanceWordsText.split('\n')
    );
  };

  const createWorkOrExamWorker = (questionRoots: string | HTMLElement[]) =>
    new OCSWorker({
      root: questionRoots,
      elements: {
        title: [(root) => root.querySelector('h3') as HTMLElement],
        options: '.answerBg .answer_p, .textDIV, .eidtDiv',
        type: type === 'exam' ? 'input[name^="type"]' : 'input[id^="answertype"]',
        lineAnswerInput: '.line_answer input[name^=answer]',
        lineSelectBox: '.line_answer_ct .selectBox ',
        reading: '.reading_answer',
        filling: '.filling_answer'
      },
      thread: thread ?? 1,
      answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
      answerMatchMode: answerMatchMode === 'includes' ? 'similar' : answerMatchMode,
      answerer: (elements, ctx) => {
        if (!elements.title) {
          throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
        }
        const title = workOrExamQuestionTitleTransform(elements.title);
        if (!title) {
          throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
        }

        const typeInput = elements.type[0] as HTMLInputElement | undefined;
        const provider = async () => {
          await sleep((period ?? 3) * 1000);
          return defaultAnswerWrapperHandler(answererWrappers, {
            type: (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown',
            title,
            options:
              ctx.type === 'completion'
                ? ''
                : ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText).join('\n')
          });
        };

        const searchInCaches = appsMethods().searchAnswerInCaches;
        return searchInCaches ? searchInCaches(title, provider) : provider();
      },
      work: async (ctx) => {
        const { elements, searchInfos } = ctx;
        const typeInput = elements.type[0] as HTMLInputElement | undefined;
        const questionType = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

        if (questionType && ['completion', 'multiple', 'judgement', 'single'].includes(questionType)) {
          const resolver = createDefaultQuestionResolver(ctx)[questionType as 'completion' | 'multiple' | 'judgement' | 'single'];
          return resolver(
            searchInfos,
            elements.options.map((option) => optimizationElementWithImage(option)),
            async (resolvedType, answer, option) => {
              if ((resolvedType === 'judgement' || resolvedType === 'single' || resolvedType === 'multiple') && option) {
                if (option.parentElement && option.parentElement.querySelectorAll('[class*="check_answer"]').length === 0) {
                  option.click();
                  await sleep(500);
                }
              } else if (resolvedType === 'completion' && option && answer.trim()) {
                const text = option.querySelector('textarea');
                const textareaFrame = option.querySelector('iframe');
                if (text) {
                  text.value = answer;
                }
                if (textareaFrame?.contentDocument) {
                  textareaFrame.contentDocument.body.innerHTML = answer;
                }
                option.parentElement?.parentElement?.querySelector<HTMLElement>('[onclick*=saveQuestion]')?.click();
                await sleep(500);
              }
            }
          );
        }

        if (questionType === 'line') {
          for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
            let ans = answers;
            if (ans.length === 1) {
              ans = splitAnswer(ans[0]);
            }
            if (ans.filter(Boolean).length !== 0 && elements.lineAnswerInput) {
              for (let index = 0; index < elements.lineSelectBox.length; index++) {
                const box = elements.lineSelectBox[index];
                if (ans[index]) {
                  box.querySelector<HTMLElement>(`li[data="${ans[index]}"] a`)?.click();
                  await sleep(200);
                }
              }
              return { finish: true };
            }
          }
          return { finish: false };
        }

        if (questionType === 'fill') {
          return readerAndFillHandle(searchInfos, elements.filling as HTMLElement[]);
        }

        if (questionType === 'reader') {
          return readerAndFillHandle(searchInfos, elements.reading as HTMLElement[]);
        }

        return { finish: false };
      },
      async onResultsUpdate(current, currentIndex, res) {
        const simplified = simplifyWorkResult(res, workOrExamQuestionTitleTransform);

        if (!preview_mode) {
          if (current.result?.finish) {
            workResultsMethods().appendResults?.(simplified);
            appsMethods().addQuestionCacheFromWorkResult?.(simplifyWorkResult([current], workOrExamQuestionTitleTransform));
          }
          return;
        }

        workResultsMethods().setResults?.(simplified);
        workResultsMethods().updateWorkStateByResults?.(res);

        const currentRoot = Array.from(document.querySelectorAll<HTMLElement>('.questionLi'))[currentIndex];
        const typeInput = currentRoot?.querySelector<HTMLInputElement>(type === 'exam' ? 'input[name^="type"]' : 'input[id^="answertype"]');
        const questionType = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;
        if (currentRoot) {
          const previousManual = workResultsMethods().getResults?.()[currentIndex]?.manual ?? false;
          workResultsMethods().patchResult?.(currentIndex, {
            manual: detectManualAnswer(currentRoot, questionType, {
              previousManual,
              result: current
            })
          });
        }

        if (current.result?.finish) {
          appsMethods().addQuestionCacheFromWorkResult?.(simplifyWorkResult([current], workOrExamQuestionTitleTransform));
        }
      }
    });

  const worker = createWorkOrExamWorker('.questionLi');

  if (preview_mode) {
    const liveRoots = () => Array.from(document.querySelectorAll<HTMLElement>('.questionLi'));
    const clearRuntimeControls = () => workResultsMethods().clearRuntimeControls?.();

    workResultsMethods().setRuntimeControls?.({
      isRunning: () => worker.isRunning,
      isStopped: () => worker.isStop,
      stop: () => worker.emit('stop'),
      continuate: () => worker.emit('continuate'),
      canRetryQuestion: (index) => Boolean(liveRoots()[index]),
      retryQuestion: async (index) => {
        const root = liveRoots()[index];
        if (!root) {
          return undefined;
        }

        const retryWorker = createWorkOrExamWorker([root]);
        const retriedResults = await retryWorker.doWork();
        return {
          ...simplifyWorkResult(retriedResults, workOrExamQuestionTitleTransform)[0],
          manual: false,
          retrying: false
        };
      }
    });

    worker.on('done', clearRuntimeControls);
    worker.on('close', clearRuntimeControls);
    void worker
      .doWork()
      .then(() => {
        $message.info({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
        worker.emit('done');
      })
      .catch((err) => {
        console.error(err);
        $message.error('答题程序发生错误 : ' + ((err as Error).message || String(err)));
      });
  } else {
    const getNextBtn = () => document.querySelector('[onclick="getTheNextQuestion(1)"]') as HTMLElement | null;
    let next = getNextBtn();

    void (async () => {
      while (next && worker.isClose === false) {
        await worker.doWork({ enable_debug: false });
        await sleep(1000);
        next = getNextBtn();
        next?.click();
        await sleep(1000);
      }

      $message.success({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
      worker.emit('done');
    })();
  }

  return worker;
}

function detectManualAnswer(
  root: HTMLElement,
  type: ReturnType<typeof getQuestionType>,
  options?: {
    previousManual?: boolean;
    result?: {
      requested?: boolean;
      resolved?: boolean;
      finish?: boolean;
      result?: {
        finish?: boolean;
      };
    };
  }
) {
  return resolveManualAnswerState({ root, type, ...options });
}

function getQuestionType(
  val: number
): 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader' | undefined {
  return val === 0
    ? 'single'
    : val === 1
      ? 'multiple'
      : val === 3
        ? 'judgement'
        : [2, 4, 5, 6, 7, 8, 9, 10].some((t) => t === val)
          ? 'completion'
          : val === 11
            ? 'line'
            : val === 14
              ? 'fill'
              : val === 15
                ? 'reader'
                : undefined;
}

async function readerAndFillHandle(searchInfos: SearchInformation[], list: HTMLElement[]) {
  for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
    let ans = answers;

    if (ans.length === 1) {
      ans = splitAnswer(ans[0]);
    }

    if (ans.filter(Boolean).length !== 0 && list.length !== 0) {
      for (let index = 0; index < ans.length; index++) {
        const item = list[index];
        if (item) {
          item.querySelector<HTMLElement>(`span.saveSingleSelect[data="${ans[index]}"]`)?.click();
          await sleep(200);
        }
      }

      return { finish: true };
    }
  }

  return { finish: false };
}

async function mappingRecognize(doc: Document = document) {
  let typrMapping: Record<string, number> = Object.create({});
  try {
    const unsafeTop = topWindow as Window & Record<string, any>;
    unsafeTop.typrMapping = unsafeTop.typrMapping || (await loadTyprMapping());
    typrMapping = unsafeTop.typrMapping || Object.create({});
  } catch {
    typrMapping = (await loadTyprMapping()) || Object.create({});
  }

  const fontFaceEl = Array.from(doc.head.querySelectorAll('style')).find((style) =>
    style.textContent?.includes('font-cxsecret')
  );

  const base64ToUint8Array = (base64: string) => {
    const data = window.atob(base64);
    const buffer = new Uint8Array(data.length);
    for (let i = 0; i < data.length; ++i) {
      buffer[i] = data.charCodeAt(i);
    }
    return buffer;
  };

  if (fontFaceEl && Object.keys(typrMapping).length > 0) {
    const font = fontFaceEl.textContent?.match(/base64,([\w\W]+?)'/)?.[1];
    if (font) {
      $console.log('正在识别繁体字');
      const code = Typr.parse(base64ToUint8Array(font));
      const match: Record<string, number> = {};
      for (let i = 19968; i < 40870; i++) {
        const glyph = Typr.U.codeToGlyph(code, i);
        if (!glyph) continue;
        const path = Typr.U.glyphToPath(code, glyph);
        const hex = md5(JSON.stringify(path)).slice(24);
        match[i.toString()] = typrMapping[hex];
      }

      const fonts = CXAnalyses.getSecretFont(doc);
      fonts.forEach((el) => {
        let html = el.innerHTML;
        for (const key in match) {
          if (!match[key]) continue;
          const word = String.fromCharCode(parseInt(key));
          const value = String.fromCharCode(match[key]);
          if (word === value) continue;
          while (html.indexOf(word) !== -1) {
            html = html.replace(word, value);
          }
        }
        el.innerHTML = html;
        el.classList.remove('font-cxsecret');
      });
      $console.log('识别繁体字完成。');
    }
  }
}

async function loadTyprMapping(): Promise<Record<string, number>> {
  try {
    $console.log('正在加载繁体字库。');
    return await request('https://cdn.ocsjs.com/resources/font/table.json', {
      type: 'fetch',
      method: 'get',
      responseType: 'json'
    });
  } catch (err) {
    $console.error('繁体字库加载失败，请刷新页面重试：', String(err));
    return Object.create({});
  }
}

export function hasFaceRecognition(root: Document | HTMLElement = topWindow.document): boolean {
  const faces = Array.from(root.querySelectorAll<HTMLImageElement>('#fcqrimg'));
  return faces.some((face) => Boolean(face.getAttribute('src')));
}

export function hasNewFaceRecognition(root: Document | HTMLElement = topWindow.document): boolean {
  const faces = Array.from(root.querySelectorAll<HTMLElement>('.chapterVideoFaceMaskDiv'));
  return faces.some((face) => face.style.display !== 'none');
}

export async function waitForNewFaceRecognition(): Promise<void> {
  let notified = false;
  await new Promise<void>((resolve) => {
    const interval = window.setInterval(() => {
      const active = hasNewFaceRecognition();
      if (active) {
        if (!notified) {
          notified = true;
          const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
          if (buildStudyOptions({}).notifyWhenHasFaceRecognition) {
            settingsMethods().notificationBySetting?.(msg);
          }
          $message.warn({ content: msg, duration: 0 });
          $console.warn(msg);
        }
      } else {
        window.clearInterval(interval);
        resolve();
      }
    }, 3000);
  });
}

export async function waitForFaceRecognition(): Promise<void> {
  let notified = false;
  await new Promise<void>((resolve) => {
    const interval = window.setInterval(() => {
      const active = hasFaceRecognition();
      if (active) {
        if (!notified) {
          notified = true;
          const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
          if (buildStudyOptions({}).notifyWhenHasFaceRecognition) {
            settingsMethods().notificationBySetting?.(msg);
          }
          $message.warn({ content: msg, duration: 0 });
          $console.warn(msg);
        }
      } else {
        window.clearInterval(interval);
        resolve();
      }
    }, 3000);
  });
}

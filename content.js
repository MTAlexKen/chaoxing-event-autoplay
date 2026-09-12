(() => {
  "use strict";

  const SPEED = 2;
  const COMPLETION_DELAY_MS = 1500;
  const RETRY_DELAY_MS = 1000;
  const MAX_RETRIES = 5;
  const COMPLETED_STORAGE_KEY = "cx-event-autoplay-completed-chapters";

  let advancing = false;
  let completedCheckScheduled = false;
  let videoSeenForChapter = false;
  let noVideoAdvanceScheduled = false;
  const observedDocuments = new WeakSet();
  const observedFrames = new WeakSet();

  const textOf = (element) => (element?.textContent || "").replace(/\s+/g, " ").trim();

  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };

  const pageDocuments = () => {
    const documents = [];
    const visited = new Set();
    const collect = (currentWindow) => {
      try {
        if (visited.has(currentWindow)) return;
        visited.add(currentWindow);
        documents.push(currentWindow.document);
        for (let index = 0; index < currentWindow.frames.length; index += 1) {
          collect(currentWindow.frames[index]);
        }
      } catch {
        // Ignore inaccessible cross-origin frames.
      }
    };
    try {
      collect(window.top === window ? window : window.top);
    } catch {
      collect(window);
    }
    return documents;
  };

  const currentChapterKey = () => {
    try {
      const href = window.top === window ? location.href : window.top.location.href;
      const url = new URL(href);
      return url.searchParams.get("chapterId") || `${url.pathname}${url.search}`;
    } catch {
      return location.href;
    }
  };

  let trackedChapterKey = currentChapterKey();

  const syncChapterState = () => {
    const key = currentChapterKey();
    if (key === trackedChapterKey) return;
    trackedChapterKey = key;
    // Chaoxing changes chapters in-place. Reset only transient state for the
    // new chapter; the completed-chapter storage remains intact for dedupe.
    advancing = false;
    completedCheckScheduled = false;
    completionNotified = false;
    videoSeenForChapter = false;
    noVideoAdvanceScheduled = false;
  };

  const completedChapters = () => {
    try {
      const value = JSON.parse(localStorage.getItem(COMPLETED_STORAGE_KEY) || "[]");
      return new Set(Array.isArray(value) ? value : []);
    } catch {
      return new Set();
    }
  };

  const markCurrentChapterCompleted = () => {
    const key = currentChapterKey();
    if (!key) return;
    const chapters = completedChapters();
    chapters.add(key);
    try {
      localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...chapters]));
    } catch {
      // Storage may be unavailable; the page-level guard still prevents duplicate clicks.
    }
  };

  const alreadyCompleted = () => completedChapters().has(currentChapterKey());

  const findByText = (root, label) => {
    const candidates = [...root.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")];
    return candidates.find((element) => isVisible(element) && textOf(element) === label);
  };

  const taskCompleted = () => {
    return pageDocuments().some((frameDocument) => {
      const bodyText = frameDocument.body?.innerText || frameDocument.body?.textContent || "";
      return bodyText.includes("任务点已完成") || bodyText.includes("已完成任务点");
    });
  };

  const replayVisible = () => {
    return pageDocuments().some((frameDocument) => {
      return [...frameDocument.querySelectorAll("button, [role='button']")]
        .some((element) => isVisible(element) && (textOf(element) === "重播" || textOf(element) === "播放视频"));
    });
  };

  const advanceFromCompletedReplay = () => {
    syncChapterState();
    // Wait until the new chapter's own player has been observed. During an
    // in-place route change Chaoxing can briefly leave the previous chapter's
    // completed label and replay control in the DOM; acting on that stale UI
    // skips the newly selected unfinished chapter.
    if (!videoSeenForChapter || !taskCompleted() || !replayVisible()) return;
    markCurrentChapterCompleted();
    if (window.top === window) {
      advanceToNext(0);
    } else {
      // The terminal player UI changes inside the nested frame; forward the
      // completion directly instead of waiting for a top-frame mutation.
      // Only the top frame is allowed to click “下一节”; otherwise the top
      // frame and the player frame can both advance and skip a chapter.
      notifyTop({ source: "cx-event-autoplay", type: "chapter-completed", chapterKey: currentChapterKey() });
    }
  };

  const notifyTop = (payload) => {
    if (window.top === window) {
      handleTopMessage({ data: payload, source: window });
    } else {
      // Sandboxed course frames may serialize their origin as "null"; the
      // top-frame handler still validates the event payload/source marker.
      window.top.postMessage(payload, "*");
    }
  };

  let completionNotified = false;

  const notifyCompletionIfVisible = (chapterKey = currentChapterKey()) => {
    syncChapterState();
    if (chapterKey !== currentChapterKey()) return;
    // A completed task label alone is not enough. Only treat it as an end
    // signal when the player also exposes its terminal “重播” state.
    if (completionNotified || !videoSeenForChapter || !taskCompleted() || !replayVisible()) return;
    completionNotified = true;
    notifyTop({
      source: "cx-event-autoplay",
      type: "chapter-completed",
      chapterKey
    });
  };

  const notifyVideoFinished = (video, chapterKey = currentChapterKey()) => {
    syncChapterState();
    if (chapterKey !== currentChapterKey()) return;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    if (!video.ended && (!Number.isFinite(duration) || duration <= 0 || currentTime + 0.75 < duration)) return;
    const completedNow = taskCompleted();
    const lastSignalAt = Number(video.dataset.cxEventAutoplayFinishSignaledAt || 0);
    if (video.dataset.cxEventAutoplayFinishTaskCompleted === "1" && completedNow) return;
    if (video.dataset.cxEventAutoplayFinishSignaled === "1" && !completedNow && Date.now() - lastSignalAt < 2000) return;
    video.dataset.cxEventAutoplayFinishSignaled = "1";
    video.dataset.cxEventAutoplayFinishSignaledAt = String(Date.now());
    if (completedNow) video.dataset.cxEventAutoplayFinishTaskCompleted = "1";
    notifyTop({
      source: "cx-event-autoplay",
      type: "video-ended",
      chapterKey,
      duration,
      currentTime,
      taskCompleted: completedNow,
      src: video.currentSrc || video.src || ""
    });
    // The player normally lives in a nested frame. The top frame receives
    // this event and performs the single guarded navigation. Do not also
    // click locally from the nested frame, or one completion can skip two
    // chapters when both content-script instances react.
    if (window.top === window) {
      window.setTimeout(() => {
        if (advancing) return;
        if (taskCompleted()) {
          markCurrentChapterCompleted();
          advanceToNext(0);
        } else {
          // Native ended only means the media reached its end. Chaoxing may
          // still be waiting for its own task-point confirmation dialog. Do
          // not click “下一节” while the current task is still incomplete.
          retryTaskCompletionAndAdvance();
        }
      }, COMPLETION_DELAY_MS);
    }
  };

  const startVideo = (video) => {
    if (taskCompleted()) {
      // Never replay a chapter that the platform already reports as complete.
      // Chaoxing may autoplay a newly loaded completed chapter before the
      // terminal control appears, so stop it immediately and move on.
      video.pause();
      markCurrentChapterCompleted();
      if (video.dataset.cxEventAutoplayCompletedGuarded !== "1") {
        video.dataset.cxEventAutoplayCompletedGuarded = "1";
        if (window.top === window) {
          window.setTimeout(() => {
            if (!advancing && taskCompleted()) advanceToNext(0);
          }, COMPLETION_DELAY_MS);
        } else {
          notifyTop({ source: "cx-event-autoplay", type: "chapter-completed", chapterKey: currentChapterKey() });
        }
      }
      return;
    }
    video.playbackRate = SPEED;
    // Chrome permits autoplay for muted media without a user gesture.
    // The course only needs playback progress, so keep auto-start silent.
    video.muted = true;
    video.volume = 0;
    if (video.dataset.cxEventAutoplayPlayRepairScheduled === "1") return;
    video.dataset.cxEventAutoplayPlayRepairScheduled = "1";
    // A newly-rendered Chaoxing player may reject the first muted play() call
    // while its controls are still settling. Retry briefly and click its own
    // play control when needed, without creating a persistent polling loop.
    const retryPlay = (attempt = 0) => {
      if (!video.paused || video.ended || attempt >= 12) {
        delete video.dataset.cxEventAutoplayPlayRepairScheduled;
        return;
      }
      video.playbackRate = SPEED;
      video.muted = true;
      video.volume = 0;
      video.play().catch(() => {});
      if (video.paused) {
        const ownerDocument = video.ownerDocument || document;
        const playButton = [...ownerDocument.querySelectorAll("button, [role='button'], .xgplayer-start")]
          .find((element) => isVisible(element) && /播放视频|播放/.test(textOf(element)));
        playButton?.click();
      }
      window.setTimeout(() => retryPlay(attempt + 1), attempt < 3 ? 250 : 750);
    };
    retryPlay();
  };

  const installVideoListener = (video) => {
    const chapterKey = currentChapterKey();
    if (video.dataset.cxEventAutoplayInstalled === "1" && video.dataset.cxEventAutoplayChapterKey === chapterKey) {
      // The task label can arrive after the player itself. Re-run the guard
      // on later DOM scans so a completed chapter cannot keep autoplaying.
      if (taskCompleted()) startVideo(video);
      return;
    }
    // A SPA route can reuse the same <video> node. Keep old listeners
    // harmless by giving each installation its chapter key; stale listeners
    // then fail the chapter-key check instead of completing the new chapter.
    delete video.dataset.cxEventAutoplayCompletedGuarded;
    delete video.dataset.cxEventAutoplayFinishSignaled;
    delete video.dataset.cxEventAutoplayFinishTaskCompleted;
    video.dataset.cxEventAutoplayInstalled = "1";
    video.dataset.cxEventAutoplayChapterKey = chapterKey;
    videoSeenForChapter = true;
    startVideo(video);
    video.addEventListener("ratechange", () => {
      if (video.playbackRate !== SPEED) video.playbackRate = SPEED;
    });
    video.addEventListener("ended", () => notifyVideoFinished(video, chapterKey));
    video.addEventListener("timeupdate", () => {
      notifyCompletionIfVisible(chapterKey);
      notifyVideoFinished(video, chapterKey);
    });
    video.addEventListener("pause", () => notifyVideoFinished(video, chapterKey));
    if (video.ended) {
      notifyVideoFinished(video, chapterKey);
    }
  };

  const skipChapterWithoutVideo = () => {
    syncChapterState();
    // Do not advance merely because the player has not appeared yet. Chaoxing
    // can load a valid video card asynchronously (and sometimes after more
    // than eight seconds); treating that delay as a reading-only chapter can
    // silently skip an unfinished video. Completion or an explicit terminal
    // player state remains the only automatic advance trigger.
    return;
  };

  const scanForVideo = () => {
    syncChapterState();
    pageDocuments().forEach((frameDocument) => {
      frameDocument.querySelectorAll("video").forEach(installVideoListener);
      frameDocument.querySelectorAll("iframe").forEach((frame) => {
        if (observedFrames.has(frame)) return;
        observedFrames.add(frame);
        frame.addEventListener("load", () => {
          // The course inserts the card/video frames asynchronously. Recheck
          // once their own document has finished loading.
          window.setTimeout(() => {
            scanForVideo();
            scheduleAdvanceIfCompleted();
          }, 0);
        });
      });
      if (frameDocument.documentElement && !observedDocuments.has(frameDocument)) {
        observedDocuments.add(frameDocument);
        new MutationObserver(scanForVideo).observe(frameDocument.documentElement, { childList: true, subtree: true });
      }
    });
    notifyCompletionIfVisible();
    // UI fallback for cases where the nested player misses or delays its
    // native ended event: the terminal “重播”/“播放视频” control plus a
    // completed task point is definitive.
    advanceFromCompletedReplay();
    skipChapterWithoutVideo();
  };

  scanForVideo();

  function handleTopMessage(event) {
    syncChapterState();
    const data = event.data;
    if (!data || data.source !== "cx-event-autoplay") return;
    if (advancing) return;
    if (event.origin && event.origin !== location.origin && event.origin !== "null") return;
    if (data.chapterKey && data.chapterKey !== currentChapterKey()) return;
    if (data.type === "chapter-completed") {
      markCurrentChapterCompleted();
      advanceToNext(0);
      return;
    }
    if (data.type !== "video-ended") return;
    if (data.duration > 0 && data.currentTime + 2 < data.duration) return;
    // Reaching the media end is not enough: Chaoxing can show a confirmation
    // dialog or update the task-point label asynchronously. Advance only when
    // the current chapter is explicitly reported complete; otherwise wait in
    // place instead of skipping the unfinished chapter.
    if (data.taskCompleted || taskCompleted()) {
      markCurrentChapterCompleted();
      advanceToNext(0);
    } else {
      retryTaskCompletionAndAdvance();
    }
  }

  function advanceToNext(retry) {
    syncChapterState();
    // Navigation is centralized in the top frame. The player frame may
    // observe the same completion, but must never perform a second click.
    if (window.top !== window) return;
    if (advancing) return;
    const next = pageDocuments()
      .map((frameDocument) => findByText(frameDocument, "下一节"))
      .find(Boolean);
    if (!next) {
      if (retry < MAX_RETRIES) window.setTimeout(() => advanceToNext(retry + 1), RETRY_DELAY_MS);
      return;
    }
    const chapterKey = currentChapterKey();
    // The SPA can reuse the same “下一节” DOM node across chapters. Scope
    // the click guard to the chapter so a prior successful click cannot
    // permanently disable autoplay for all later videos.
    if (next.dataset.cxEventAutoplayClickedChapter === chapterKey) return;
    advancing = true;
    next.dataset.cxEventAutoplayClickedChapter = chapterKey;
    const urlBeforeClick = window.top === window ? location.href : window.top.location.href;
    // Chaoxing sometimes renders “下一节” as an anchor whose default action
    // is a javascript: URL. Calling HTMLElement.click() on that anchor makes
    // Chrome reject the navigation under the page CSP, so dispatch the page
    // click while cancelling only that unsafe default navigation. The page's
    // normal onclick/delegated handler still receives the event and can
    // perform the SPA transition without producing an extension error.
    const href = next.getAttribute?.("href") || "";
    if (/^javascript:/i.test(href)) {
      const suppressUnsafeDefault = (event) => event.preventDefault();
      next.addEventListener("click", suppressUnsafeDefault, { capture: true, once: true });
      next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } else {
      next.click();
    }
    // If the site ignored a synthetic click, allow the event-triggered retry
    // burst to try again without leaving the extension permanently locked.
    window.setTimeout(() => {
      try {
        const urlAfterClick = window.top === window ? location.href : window.top.location.href;
        if (!advancing || urlAfterClick !== urlBeforeClick) return;
        advancing = false;
        delete next.dataset.cxEventAutoplayClickedChapter;
        if (retry < MAX_RETRIES) advanceToNext(retry + 1);
      } catch {
        advancing = false;
      }
    }, 4000);
  }

  const retryCompletionBurst = (attempt = 0) => {
    if (advancing || attempt >= 20) return;
    if (videoSeenForChapter && taskCompleted() && replayVisible()) {
      markCurrentChapterCompleted();
      advanceToNext(0);
      return;
    }
    window.setTimeout(() => retryCompletionBurst(attempt + 1), 500);
  };

  const retryTaskCompletionAndAdvance = (attempt = 0) => {
    syncChapterState();
    if (advancing || attempt >= 24) return;
    if (taskCompleted()) {
      markCurrentChapterCompleted();
      advanceToNext(0);
      return;
    }
    // Give Chaoxing up to twelve seconds to commit the task point. If it does
    // not, leave the user on the current chapter for manual confirmation;
    // silently moving on would lose the video from the learning record.
    window.setTimeout(() => retryTaskCompletionAndAdvance(attempt + 1), 500);
  };

  const scheduleAdvanceIfCompleted = () => {
    syncChapterState();
    if (advancing || completedCheckScheduled || !videoSeenForChapter || !taskCompleted() || !replayVisible()) return;
    completedCheckScheduled = true;
    markCurrentChapterCompleted();
    window.setTimeout(() => {
      completedCheckScheduled = false;
      if (!advancing && taskCompleted() && replayVisible()) advanceToNext(0);
    }, COMPLETION_DELAY_MS);
  };

  if (window.top === window) {
    window.addEventListener("message", handleTopMessage);
    scheduleAdvanceIfCompleted();
    scanForVideo();
    // Let asynchronously rendered card/video frames settle. This is a
    // bounded startup burst, not a persistent polling monitor.
    window.setTimeout(() => retryCompletionBurst(), 250);
    // Give asynchronously-created course frames a bounded set of startup
    // checks without falling back to a minute-based polling loop.
    [0, 250, 750, 1500, 3000].forEach((delay) => {
      window.setTimeout(() => {
        scanForVideo();
        scheduleAdvanceIfCompleted();
      }, delay);
    });
    window.addEventListener("load", () => {
      scanForVideo();
      scheduleAdvanceIfCompleted();
    }, { once: true });
    new MutationObserver(() => {
      scanForVideo();
      scheduleAdvanceIfCompleted();
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Chaoxing advances chapters with in-place history changes. Re-arm the
    // transient state and startup checks so a previous chapter cannot leave
    // the new player unobserved or keep the advance guard locked.
  const notifyRouteChange = () => {
    syncChapterState();
    // A route change can reuse the same button/player nodes. Remove only the
    // old chapter's transient click marker so the new chapter can advance.
    pageDocuments().forEach((frameDocument) => {
      frameDocument.querySelectorAll("[data-cx-event-autoplay-clicked-chapter]")
        .forEach((element) => element.removeAttribute("data-cx-event-autoplay-clicked-chapter"));
    });
    advancing = false;
      completedCheckScheduled = false;
      completionNotified = false;
      videoSeenForChapter = false;
      noVideoAdvanceScheduled = false;
      [0, 250, 750, 1500, 3000, 8000].forEach((delay) => {
        window.setTimeout(() => {
          scanForVideo();
          scheduleAdvanceIfCompleted();
        }, delay);
      });
    };
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      notifyRouteChange();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      notifyRouteChange();
      return result;
    };
    window.addEventListener("popstate", notifyRouteChange);
  }
})();

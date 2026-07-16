(function() {
  const TARGET_DOMAIN = 'www.netflix.com';

  function isTargetHost(host) {
    if (!host) return false;
    return host === TARGET_DOMAIN ||
      host === 'netflix.com' ||
      host.endsWith('.netflix.com') ||
      host.endsWith('.nflxext.com') ||
      host.endsWith('.nflximg.com') ||
      host.endsWith('.nflximg.net') ||
      host.endsWith('.nflxvideo.net') ||
      host.endsWith('.nflxso.net');
  }

  function rewriteUrl(url) {
    if (!url) return url;
    if (typeof url !== 'string') return url;

    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('#')) return url;
    if (url.includes('/_g/') || url.includes('/_next/') || url.includes('/api/') || url.startsWith('/__') || url.includes('/site-login') || url.includes('/admin') || url.includes('/admin-login') || url.includes('/public/')) return url;

    try {
      const parsedUrl = new URL(url, window.location.origin);

      if (parsedUrl.host === window.location.host) return url;

      if (isTargetHost(parsedUrl.host)) {
        return parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;
      }

      return `/_g/${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    } catch (e) {
      return url;
    }
  }

  function rewriteElement(el) {
    if (!el || el.nodeType !== 1) return;
    ['src', 'href', 'action', 'data-src', 'data-href'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (!val) return;
      const rewritten = rewriteUrl(val);
      if (rewritten !== val) el.setAttribute(attr, rewritten);
    });
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    if (args[0] && typeof args[0] === 'string') {
      if (args[0].match(/\/billing|\/subscription|\/settings|\/account|\/pricing|\/logout|\/SignOut/i)) {
        window.location.href = '/dashboard';
        return new Promise(() => {});
      }
      args[0] = rewriteUrl(args[0]);
    } else if (args[0] && args[0] instanceof Request) {
      if (args[0].url.match(/\/billing|\/subscription|\/settings|\/account|\/pricing|\/logout|\/SignOut/i)) {
        window.location.href = '/dashboard';
        return new Promise(() => {});
      }
      const newUrl = rewriteUrl(args[0].url);
      args[0] = new Request(newUrl, args[0]);
    }

    const response = await originalFetch.apply(this, args);
    if (response.status === 429) {
      const clone = response.clone();
      try {
        const json = await clone.json();
        if (json.redirect) window.location.href = json.redirect;
      } catch (e) {
        window.location.href = '/limitreach';
      }
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string') {
      if (url.match(/\/billing|\/subscription|\/settings|\/account|\/pricing|\/logout|\/SignOut/i)) {
        window.location.href = '/dashboard';
        return;
      }
      url = rewriteUrl(url);
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this.status === 429) {
        try {
          const json = JSON.parse(this.responseText);
          if (json.redirect) window.location.href = json.redirect;
        } catch(e) {
          window.location.href = '/limitreach';
        }
      }
    });
    return originalSend.apply(this, args);
  };

  const originalPushState = history.pushState;
  history.pushState = function(state, title, url) {
    if (url) url = rewriteUrl(url);
    return originalPushState.call(this, state, title, url);
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function(state, title, url) {
    if (url) url = rewriteUrl(url);
    return originalReplaceState.call(this, state, title, url);
  };

  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = function(url, configuration) {
      url = rewriteUrl(url);
      return new OriginalEventSource(url, configuration);
    };
  }

  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      url = rewriteUrl(url);
      return originalSendBeacon.call(navigator, url, data);
    };
  }

  const originalWindowOpen = window.open;
  window.open = function(url, target, features) {
    if (url) url = rewriteUrl(url);
    return originalWindowOpen.call(window, url, target, features);
  };

  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (link && link.href) {
      const rewritten = rewriteUrl(link.href);
      if (rewritten !== link.href) link.href = rewritten;
    }
  }, true);

  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form && form.action) form.action = rewriteUrl(form.action);
  }, true);

  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        rewriteElement(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('script[src], link[href], img[src], iframe[src], video[src], audio[src]').forEach(rewriteElement);
        }
      });
    });
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'action', 'data-src', 'data-href'] });
    document.querySelectorAll('link[href], script[src], img[src]').forEach(rewriteElement);
  }

  setInterval(() => {
    const blockedTexts = ["Plans & Pricing", "FAQ", "Support", "Discord", "Affiliate", "Logout", "Sign out", "Account", "Free Plan"];
    document.querySelectorAll('a, button, span, li').forEach(el => {
      if (el.children.length > 1) return;
      const text = el.textContent.trim();
      const lowerText = text.toLowerCase();
      if (blockedTexts.includes(text) || lowerText.includes('sign out') || lowerText.includes('logout')) {
        el.style.display = 'none';
      }
      if (text.includes('@') && text.length > 5 && text.includes('.')) {
        el.style.display = 'none';
      }
    });
  }, 500);

})();

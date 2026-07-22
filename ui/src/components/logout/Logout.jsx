/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { xhrPost } from '../../services/xhr';
import { IconUser } from '@douyinfe/semi-icons';
import React from 'react';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { clearManualLogout, markManualLogout } from '../../services/oidc.js';

const Logout = function Logout({ text }) {
  const t = useTranslation();
  const [pending, setPending] = React.useState(false);
  const handleLogout = async () => {
    if (pending) return;
    setPending(true);
    markManualLogout();
    try {
      const response = await xhrPost('/api/login/logout');
      location.assign(response.json.redirect || '/#/login?manual=1');
    } catch {
      clearManualLogout();
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      aria-label={t('nav.logout')}
      title={t('nav.logout')}
      disabled={pending}
      className={`navigate__logout-btn${!text ? ' navigate__logout-btn--icon-only' : ''}`}
      onClick={handleLogout}
    >
      <IconUser size="default" />
      {text && t('nav.logout')}
    </button>
  );
};

export default Logout;

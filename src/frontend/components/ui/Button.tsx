import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = '',
      variant = 'secondary',
      size = 'md',
      isLoading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const variantClass = `btn-${variant}`;
    const sizeClass = size !== 'md' ? `btn-${size}` : '';
    const loadingClass = isLoading ? 'btn-loading' : '';

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || isLoading}
        className={`btn ${variantClass} ${sizeClass} ${loadingClass} ${className}`.trim()}
        {...props}
      >
        {isLoading && <span className="spinner-sm" aria-hidden="true" />}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
